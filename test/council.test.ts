/** Unit tests for the pure council-selection logic. */
import { expect, test } from "bun:test";
import { selectCouncil } from "../src/council.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

test("selectCouncil: no request → the default active council", () => {
  expect(selectCouncil(undefined, ["codex", "gemini", "grok"])).toEqual(["codex", "gemini", "grok"]);
  expect(selectCouncil([], ["codex", "gemini", "grok"])).toEqual(["codex", "gemini", "grok"]);
});

test("selectCouncil: explicit request is honored, deduped, in canonical (active) order", () => {
  expect(selectCouncil(["grok"], ["codex", "gemini", "grok"])).toEqual(["grok"]);
  expect(selectCouncil(["grok", "codex", "grok"], ["codex", "gemini", "grok"])).toEqual(["codex", "grok"]);
});

test("selectCouncil: the host can't be made to consult itself (intersected with active)", () => {
  // Claude is host → not in active; naming it is simply dropped.
  expect(selectCouncil(["claude", "codex"], ["codex", "gemini", "grok"])).toEqual(["codex"]);
});

test.each([
  { clientName: "claude-code", expectedHost: "Claude", expectedCouncil: ["Codex", "Gemini", "Grok"], excludedId: "claude" },
  { clientName: "codex-mcp-client", expectedHost: "Codex", expectedCouncil: ["Gemini", "Grok", "Claude"], excludedId: "codex" },
  { clientName: "antigravity-cli", expectedHost: "Gemini", expectedCouncil: ["Codex", "Grok", "Claude"], excludedId: "gemini" },
  { clientName: "agy", expectedHost: "Gemini", expectedCouncil: ["Codex", "Grok", "Claude"], excludedId: "gemini" },
  { clientName: "grok-cli", expectedHost: "Grok", expectedCouncil: ["Codex", "Gemini", "Claude"], excludedId: "grok" },
])("default roster gives three active council members plus the host ($clientName)", async ({ clientName, expectedHost, expectedCouncil, excludedId }) => {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const env = { ...getDefaultEnvironment() };
  delete env.MAGI_COUNCIL_MEMBERS;
  delete env.MAGI_COUNCIL_EXCLUDE;
  const transport = new StdioClientTransport({
    command: "bun",
    args: [resolve("src/index.ts")],
    stderr: "pipe",
    env,
  });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "status", arguments: {} });
    const text = (status.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(`host: ${expectedHost} (excluded; source=clientInfo`);
    expect(text).toContain("roster: Codex, Gemini, Grok, Claude");
    expect(text).toContain(`council: ${expectedCouncil.join(", ")}`);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain(`ask_${excludedId}`);
    expect(tools).not.toContain(`${excludedId}_reply`);
    expect(tools).not.toContain(`delegate_${excludedId}`);
    for (const advisor of ["codex", "gemini", "grok", "claude"].filter((id) => id !== excludedId)) {
      expect(tools).toContain(`ask_${advisor}`);
      expect(tools).toContain(`${advisor}_reply`);
      expect(tools).toContain(`delegate_${advisor}`);
    }
  } finally {
    await client.close();
  }
});

test.each(["answer", "truncated"])("consult isolates refinement stages and rejects incomplete artifacts (%s)", async (scenario) => {
  const workspace = mkdtempSync(join(tmpdir(), "magi-refinement-test-"));
  const promptsFile = join(workspace, "prompts.jsonl");
  const fakeCommand = `bun run ${resolve("test/fake-acp.ts")} --scenario ${scenario}`;
  const client = new Client({ name: "codex-test-host", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "bun", args: [resolve("src/index.ts")], stderr: "pipe",
    env: {
      ...getDefaultEnvironment(), MAGI_COUNCIL_WORKSPACE: workspace,
      MAGI_COUNCIL_MEMBERS: "codex,grok,claude", MAGI_COUNCIL_EXCLUDE: "",
      MAGI_COUNCIL_GROK_ACP_COMMAND: fakeCommand,
      MAGI_COUNCIL_CLAUDE_ACP_COMMAND: fakeCommand,
      FAKE_ACP_PROMPTS_FILE: promptsFile,
    },
  });
  try {
    await client.connect(transport);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "consult", arguments: { question: "Solve the task independently.", ...args } });
    const draft = await call({});
    expect(draft.isError).not.toBe(true);
    const readPrompts = () => readFileSync(promptsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; prompt: Array<{ text: string }> });
    expect(readPrompts()).toHaveLength(2);
    if (scenario === "truncated") {
      const text = JSON.stringify(draft.content);
      expect(text).toContain("Incomplete advisor output (max_tokens)");
      expect(text).toContain("Do not use it as a candidate or critique");
      expect(text).not.toContain("Hello from fake [ANSWER]");
      return;
    }
    expect((await call({ phase: "critique", previous: { claude: { candidate: "CLAUDE_CANDIDATE" } } })).isError).toBe(true);
    expect((await call({ phase: "draft", previous: { grok: { candidate: "PEER_POSITION" } } })).isError).toBe(true);
    expect(readPrompts()).toHaveLength(2);
    const previous = {
      claude: { candidate: "CLAUDE_CANDIDATE", critique: "CLAUDE_CRITIQUE" },
      grok: { candidate: "GROK_CANDIDATE", critique: "GROK_CRITIQUE" },
    };
    expect((await call({ phase: "critique", previous })).isError).not.toBe(true);
    expect((await call({ phase: "revise", previous: { claude: { candidate: "C" }, grok: { candidate: "G" } } })).isError).toBe(true);
    expect(readPrompts()).toHaveLength(4);
    expect((await call({ phase: "revise", previous })).isError).not.toBe(true);
    const prompts = readPrompts();
    expect(prompts).toHaveLength(6);
    expect(new Set(prompts.map((entry) => entry.pid)).size).toBe(6);
    for (const entry of prompts) {
      const text = entry.prompt.map((part) => part.text).join("\n");
      const own = text.startsWith("You are Claude") ? "CLAUDE" : "GROK";
      const peer = own === "CLAUDE" ? "GROK" : "CLAUDE";
      expect(text).not.toContain(`${peer}_CANDIDATE`);
      expect(text).not.toContain(`${peer}_CRITIQUE`);
      if (text.includes('phase="draft"')) {
        expect(text).not.toContain("<candidate>");
      } else {
        expect(text).toContain(`${own}_CANDIDATE`);
        if (text.includes('phase="revise"')) expect(text).toContain(`${own}_CRITIQUE`);
        else expect(text).not.toContain(`${own}_CRITIQUE`);
      }
    }
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}, 10_000);
