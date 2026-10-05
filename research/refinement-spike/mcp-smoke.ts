import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = await mkdtemp(join(tmpdir(), "magi-mcp-smoke-"));
const marker = `magi-${randomUUID()}`;
await writeFile(join(workspace, "probe.txt"), marker);
const client = new Client({ name: "magi-compatibility-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "bun", args: [resolve("src/index.ts")], stderr: "pipe",
  env: { ...getDefaultEnvironment(), MAGI_COUNCIL_WORKSPACE: workspace, MAGI_COUNCIL_MEMBERS: "codex,claude,grok,copilot" },
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const consult = listed.tools.find((tool) => tool.name === "consult");
  if (!consult) throw new Error("consult tool missing");
  const args = {
    question: "Read probe.txt and return only its exact contents. Do not edit files.",
    members: ["codex", "claude"], models: { codex: "gpt-6-astra", claude: "opus" },
    efforts: { codex: "medium", claude: "medium" }, time: 60,
  };
  const stages = [];
  let previous: Record<string, { candidate: string; critique?: string }> = {};
  for (const phase of ["draft", "critique", "revise"] as const) {
    const result = await client.callTool({ name: "consult", arguments: { ...args, phase, ...(phase === "draft" ? {} : { previous }) } }, undefined, { timeout: 180_000 });
    const text = (result.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const voices = [...text.matchAll(/(?:^|\n)### (Codex|Claude)\n([\s\S]*?)(?=\n---\n|$)/g)];
    if (result.isError || voices.length !== 2 || voices.some((voice) => voice[2]?.includes("Incomplete advisor output"))) throw new Error(`${phase} failed: ${text}`);
    for (const voice of voices) {
      const id = voice[1] === "Codex" ? "codex" : "claude";
      if (phase === "critique") previous[id]!.critique = voice[2]!;
      else previous[id] = { candidate: voice[2]! };
    }
    stages.push({ phase, result });
    console.log(`MCP consult ${phase}: complete`);
  }
  const passed = ["codex", "claude"].every((id) => previous[id]?.candidate.includes(marker));
  const status = await client.callTool({ name: "status", arguments: {} });
  await writeFile("research/refinement-spike/mcp-refinement-smoke.json", JSON.stringify({
    date: new Date().toISOString(), toolNames: listed.tools.map((tool) => tool.name), stages, status, passed,
  }, null, 2) + "\n");
  console.log(`MCP refinement: ${passed ? "PASS" : "FAIL"}`);
  if (!passed) process.exitCode = 1;
} finally {
  await client.close();
}
