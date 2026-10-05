import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(process.argv[2] ?? "research/refinement-spike/runs/2026-10-05");
const options: ts.CompilerOptions = {
  strict: true, noEmit: true, skipLibCheck: true, types: [],
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, lib: ["lib.es2022.d.ts"],
};
const results: Array<{ file: string; errors: string[] }> = [];
async function inspect(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { await inspect(file); continue; }
    if (!entry.name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(file, "utf8"));
    if (!record.score || typeof record.result?.text !== "string") continue;
    const source = record.result.text.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)```/)?.[1] ?? record.result.text.trim();
    const candidate = join(dir, "candidate.ts");
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === candidate
      ? ts.createSourceFile(name, source, languageVersion, true)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([candidate], options, host);
    const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    results.push({ file: file.slice(root.length + 1), errors });
  }
}
await inspect(root);
const passed = results.length > 0 && results.every((result) => result.errors.length === 0);
await writeFile(join(root, "typecheck.json"), JSON.stringify({ passed, implementations: results.length, results }, null, 2) + "\n");
console.log(`${results.filter((result) => result.errors.length === 0).length}/${results.length} implementations pass strict TypeScript`);
if (!passed) process.exitCode = 1;
