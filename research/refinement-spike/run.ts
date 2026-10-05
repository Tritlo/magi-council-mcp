import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { loadConfig } from "../../src/config.ts";
import { AcpSession, type AskResult } from "../../src/session.ts";
import { magiAdvisorPrompt } from "./baseline.ts";
import { cases, type ExperimentCase } from "./cases.ts";

type Member = "codex" | "claude";
type Protocol = "baseline" | "refinement";
const models: Record<Member, string> = { codex: "gpt-6-astra", claude: "opus" };
const effort = "medium";
const output = resolve(process.argv[2] ?? `research/refinement-spike/runs/${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const config = { ...loadConfig(), turnTimeoutMs: 90_000, logFile: undefined };
const rules = "This is a self-contained code experiment. Use only the supplied problem and artifacts. Do not use tools, access files, consult other agents, or search. The evaluator is unavailable. Keep critiques below 250 words. For implementation turns, return only the complete TypeScript source, without Markdown fences or prose.";

function score(task: ExperimentCase, response: string) {
  const fenced = response.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)```/);
  const source = fenced?.[1] ?? response.trim();
  try {
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    const checks = task.checks.map((check) => {
      try {
        const context = createContext({ exports: {}, args: structuredClone(check.input) }, { codeGeneration: { strings: false, wasm: false } });
        runInContext(compiled.outputText, context, { timeout: 1000 });
        const actual = JSON.parse(runInContext(`JSON.stringify(exports[${JSON.stringify(task.exportName)}](...args))`, context, { timeout: 1000 }));
        return { name: check.name, passed: isDeepStrictEqual(actual, check.expected), actual, expected: check.expected };
      } catch (error) {
        return { name: check.name, passed: false, error: String(error) };
      }
    });
    return { passed: checks.filter((check) => check.passed).length, total: checks.length, checks };
  } catch (error) {
    return { passed: 0, total: task.checks.length, error: String(error), checks: task.checks.map((check) => ({ name: check.name, passed: false, error: String(error) })) };
  }
}

async function trial(task: ExperimentCase, protocol: Protocol) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `magi-${task.id}-${protocol}-`));
  const dir = join(output, task.id, protocol);
  await mkdir(dir, { recursive: true });
  const sessions = {
    codex: new AcpSession({ ...config, workspaceRoot }, config.codex, { pinnedMode: "read-only" }),
    claude: new AcpSession({ ...config, workspaceRoot }, config.claude, { pinnedMode: "default" }),
  };
  const records: Array<{ stage: string; member: Member; result: AskResult; score?: ReturnType<typeof score> }> = [];
  const started = Date.now();
  async function turn(member: Member, stage: string, prompt: string, implementation = false): Promise<string> {
    const fullPrompt = `${rules}\n\n${prompt}`;
    console.error(`${task.id}/${protocol}/${stage}: ${member}`);
    const outcome = await sessions[member].ask(fullPrompt, {
      model: models[member], effort, label: stage, onAskPermission: "read-only", signal: AbortSignal.timeout(180_000),
    });
    if (outcome.type !== "answer") throw new Error(`${stage}: unexpected permission request`);
    const record = { stage, member, result: outcome.result, ...(implementation ? { score: score(task, outcome.result.text) } : {}) };
    records.push(record);
    await writeFile(join(dir, `${stage}.json`), JSON.stringify({ prompt: fullPrompt, ...record }, null, 2) + "\n");
    if (outcome.result.stopReason !== "end_turn") throw new Error(`${stage}: ${outcome.result.stopReason}`);
    if (outcome.result.log.some((line) => line.startsWith("tool:") || line.startsWith("read:"))) throw new Error(`${stage}: used tools in a tool-free experiment`);
    if (record.score) console.error(`${stage}: ${record.score.passed}/${record.score.total}`);
    return outcome.result.text;
  }
  try {
    const inventories = await Promise.all([sessions.codex.availableSelectors(AbortSignal.timeout(60_000)), sessions.claude.availableSelectors(AbortSignal.timeout(60_000))]);
    await writeFile(join(dir, "inventory.json"), JSON.stringify(inventories, null, 2) + "\n");
    let final: string;
    if (protocol === "baseline") {
      let draft = await turn("codex", "01-draft", task.prompt, true);
      for (let round = 1; round <= 4; round++) {
        const review = await turn("claude", `${round * 2}-review`, magiAdvisorPrompt({
          advisor: "Opus", host: "Astra", question: task.prompt, hostTake: draft,
          context: "Review the current host implementation. Identify concrete correctness problems and justified agreements. Do not implement it yourself.",
        }));
        draft = await turn("codex", `${round * 2 + 1}-revision`, `Review Opus's feedback. Correct errors where justified, preserve valid behavior, and resolve the task. Return the full implementation.\n\n<feedback>\n${review}\n</feedback>`, true);
      }
      final = draft;
    } else {
      await Promise.all([
        turn("codex", "01-astra-draft", task.prompt, true),
        turn("claude", "02-opus-draft", task.prompt, true),
      ]);
      const critique = "Critique your own implementation against the full specification. Identify concrete errors and counterexamples. State what is valid and should remain. Do not rewrite the code yet.";
      await Promise.all([turn("codex", "03-astra-critique", critique), turn("claude", "04-opus-critique", critique)]);
      const revise = "Reconsider your critique against the specification, then revise your implementation. Preserve correct behavior. Return the complete implementation.";
      const [ar, or] = await Promise.all([
        turn("codex", "05-astra-revision", revise, true), turn("claude", "06-opus-revision", revise, true),
      ]);
      const cross = (other: string) => `Compare this independently revised peer implementation with yours. Identify concrete correctness issues and justified agreements. Critique only; do not rewrite the code.\n\n<peer>\n${other}\n</peer>`;
      const [ac, oc] = await Promise.all([
        turn("codex", "07-astra-cross-review", cross(or)), turn("claude", "08-opus-cross-review", cross(ar)),
      ]);
      final = await turn("codex", "09-synthesis", `Decide the final implementation using the specification and both critiques. Agreement alone is insufficient. Preserve correct behavior and repair demonstrated errors. Return the complete implementation.\n\n<peer_critique>\n${oc}\n</peer_critique>\n<your_critique>\n${ac}\n</your_critique>`, true);
    }
    const implementations = records.filter((record) => record.score !== undefined);
    const changes = implementations.map((record, index) => {
      const previous = implementations.slice(0, index).findLast((other) => other.member === record.member);
      const before = new Map(previous?.score?.checks.map((check) => [check.name, check.passed]) ?? []);
      return {
        stage: record.stage, member: record.member, passed: record.score!.passed,
        recoveries: record.score!.checks.filter((check) => before.get(check.name) === false && check.passed).length,
        regressions: record.score!.checks.filter((check) => before.get(check.name) === true && !check.passed).length,
      };
    });
    const summary = {
      case: task.id, protocol, models, effort, turns: records.length, elapsedMs: Date.now() - started,
      summedTurnMs: records.reduce((sum, record) => sum + record.result.ms, 0),
      reportedTokens: records.reduce((sum, record) => sum + (record.result.usage?.totalTokens ?? 0), 0),
      turnsWithUsage: records.filter((record) => record.result.usage !== undefined).length,
      final: score(task, final), changes,
    };
    await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    return summary;
  } catch (error) {
    await writeFile(join(dir, "failure.json"), JSON.stringify({ error: String(error), completedStages: records.map((record) => record.stage) }, null, 2) + "\n");
    throw error;
  } finally {
    sessions.codex.dispose(); sessions.claude.dispose();
  }
}

await writeFile(join(output, "design.json"), JSON.stringify({
  date: new Date().toISOString(), models, effort, commands: { codex: config.codex.acpCommand, claude: config.claude.acpCommand },
  budget: "9 calls per condition: 5 Astra, 4 Opus. 180 second wall limit per call. Token budgets are not enforced by ACP.",
  evaluation: "Two synthetic, deterministic repair tasks; 15 held-out checks each. Scores never enter agent prompts.",
}, null, 2) + "\n");
const summaries = [];
for (const [index, task] of cases.entries()) {
  const order: Protocol[] = index % 2 === 0 ? ["baseline", "refinement"] : ["refinement", "baseline"];
  for (const protocol of order) summaries.push(await trial(task, protocol));
}
await writeFile(join(output, "summary.json"), JSON.stringify(summaries, null, 2) + "\n");
console.log(output);
