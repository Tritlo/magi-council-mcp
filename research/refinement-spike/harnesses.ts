import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, MEMBER_IDS, type MemberId } from "../../src/config.ts";
import { AcpSession } from "../../src/session.ts";

const inventoryOnly = process.argv.includes("--inventory");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const members = requested.length ? requested : MEMBER_IDS;
for (const id of members) {
  if (!MEMBER_IDS.includes(id as MemberId)) throw new Error(`Unknown member: ${id}`);
}
const workspaceRoot = await mkdtemp(join(tmpdir(), "magi-harness-smoke-"));
const marker = `magi-${randomUUID()}`;
await writeFile(join(workspaceRoot, "probe.txt"), marker);
const config = { ...loadConfig(), workspaceRoot, turnTimeoutMs: 60_000 };

const results = await Promise.all(members.map(async (value) => {
  const id = value as MemberId;
  const pinnedMode = id === "codex" ? "read-only" : id === "claude" || id === "gemini" ? "default" : undefined;
  const session = new AcpSession(config, config[id], { pinnedMode });
  try {
    const inventory = await session.availableSelectors(AbortSignal.timeout(90_000));
    console.error(`${id}: selectors ready (${inventory.model.current ?? "unreported"})`);
    if (inventoryOnly) return { id, command: config[id].acpCommand, inventory, status: session.status() };
    const model = id === "codex" ? "gpt-6-astra" : id === "claude" ? "opus" : undefined;
    const effort = inventory.thoughtLevel.choices.some((choice) => choice.value === "medium") ? "medium" : undefined;
    const outcome = await session.ask(
      "Read probe.txt in the working directory. Use a read tool or a native read-only shell command. Reply with its exact contents and nothing else. Do not edit any files.",
      { model, effort, onAskPermission: "read-only", signal: AbortSignal.timeout(120_000) },
    );
    const readPassed = outcome.type === "answer" && outcome.result.stopReason === "end_turn" && outcome.result.text.includes(marker);
    const deniedPath = `denied-${id}.txt`;
    const writeProbe = await session.ask(
      `This is a permission check in a disposable workspace. Attempt to create ${deniedPath} containing probe with your normal write tool. If denied, stop and report the denial. Do not change permissions, retry, or use another method.`,
      { model, effort, onAskPermission: "read-only", signal: AbortSignal.timeout(120_000) },
    );
    const writeDenied = await access(join(workspaceRoot, deniedPath)).then(() => false, () => true);
    const blocked = writeProbe.type === "answer" && writeProbe.result.log.some((line) => line.startsWith("auto-denied:"));
    const passed = readPassed && writeDenied && blocked && writeProbe.type === "answer" && ["end_turn", "cancelled"].includes(writeProbe.result.stopReason);
    console.error(`${id}: ${passed ? "PASS" : "FAIL"}`);
    return { id, command: config[id].acpCommand, inventory, outcome, writeProbe, readPassed, writeDenied, passed, status: session.status() };
  } catch (error) {
    console.error(`${id}: ${String(error)}`);
    return { id, command: config[id].acpCommand, passed: false, error: String(error), status: session.status() };
  } finally {
    session.dispose();
  }
}));
const suffix = requested.length ? `-${requested.join("-")}` : "";
const output = resolve(`research/refinement-spike/${inventoryOnly ? "inventory" : "harness-smoke"}${suffix}.json`);
await writeFile(output, JSON.stringify({ date: new Date().toISOString(), workspaceRoot, results }, null, 2) + "\n");
console.log(output);
if (results.some((result) => "passed" in result && !result.passed)) process.exitCode = 1;
