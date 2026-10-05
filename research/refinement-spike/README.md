# Independent Refinement Spike

This experiment compares two collaboration protocols on two synthetic TypeScript
repair tasks. The tasks cover selector resolution and streaming state assembly.
They use council concepts, but they are not reports of production defects.

Each condition uses GPT-6 Astra as the host and Opus 5.5 as the advisor. Both use
medium effort. Each condition has nine calls: five Astra calls and four Opus calls.

- Baseline: Astra writes a draft. Opus reviews it. Astra revises it. Repeat the
  review and revision four times. Reviews use the frozen pre-refinement council
  prompt in `baseline.ts`.
- Refinement: each participant writes an independent draft, critiques its own
  draft, and revises it. Each then reviews the other revision. Astra produces the
  final implementation from the proposals and critiques.

The host runs through the same ACP client as the advisor. This makes the run
repeatable. It does not reproduce the context of a host in an ongoing coding task.
Each condition creates two separate persistent sessions in a temporary directory.
Only task prompts and candidate responses enter those sessions. The fifteen checks
for each task stay in the runner. Check results never enter participant prompts.
The run fails if a participant uses a tool or does not finish its turn normally.

## Run

From the repository root, with both harnesses authenticated:

```sh
bun install
bun run typecheck
bun run research/refinement-spike/run.ts research/refinement-spike/runs/my-run
bun run research/refinement-spike/validate.ts research/refinement-spike/runs/my-run
```

Use a new output directory for each run. Prompts, responses, reported usage,
elapsed time, checks, and summaries are saved after each stage. A failed run
retains completed stages and a failure report. Sessions are disposed on exit.

The baseline runs first on the selector task. Refinement runs first on the
streaming task. This reverses the order once, but does not control service load
or cache state. Initial drafts are sampled separately for each condition.
Both conditions spend all nine calls, even after agreement. This controls call
counts and permits regression checks. It does not measure the cost of a host that
stops the production workflow early.

## Harness Checks

```sh
bun run research/refinement-spike/harnesses.ts --inventory
bun run research/refinement-spike/harnesses.ts
bun run research/refinement-spike/mcp-smoke.ts
```

The first command starts each configured adapter and records its selectors.
The second checks a file read and a denied write in a temporary workspace.
The third starts the MCP server and checks both Opus and Astra through all three
`consult` stages. It saves `mcp-refinement-smoke.json` separately from the original
single-round smoke.
Pass a member id to check one harness, for example `harnesses.ts grok`.
Filtered runs save a separate file such as `harness-smoke-grok.json`.
The smoke uses default fallback launch commands unless command overrides are set.
It reports authentication and account-access failures separately from replies.

## Interpretation

The paper motivates independent refinement before aggregation:
[Refining Over Resampling](https://arxiv.org/html/2608.05643v1).
This experiment adapts the idea to two different models and host synthesis. It
does not reproduce the paper's eight trajectories, four depths, or voting rule.

The budget matches call counts and per-member effort. ACP does not enforce an
equal token budget here. Each call has a 180-second wall limit and a 90-second
idle limit. Token totals are the sum of reported prompt usage, including cache
tokens. They are not prices or FLOP measurements. Wall time includes session
startup and evaluation. Concurrent refinement stages can reduce wall time without
reducing compute.

Evaluation compiles TypeScript syntax and runs each supplied check in an isolated
VM context with a one-second limit. It does not establish correctness beyond those
checks. The VM is not a security boundary for arbitrary untrusted code. No tools,
imports, or code evaluation are requested from the participants. Separate strict
type checking validates the recorded implementations after the run.

Two tasks and one trial per condition can detect workflow failures. They cannot
establish a general quality advantage. Perfect initial scores indicate that harder
tasks are needed to measure recovery. Record negative results as well as gains.
