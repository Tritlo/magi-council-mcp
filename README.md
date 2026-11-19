# magi-council-mcp

A small MCP server that lets a coding agent **consult other frontier models
mid-task** — **Codex**, **Gemini (Google Antigravity)**, **Grok (xAI)**, and
**Claude (Anthropic)** — for a second opinion, plan review, diff review,
brainstorming, exploration, media generation, and a **Magi council**. The council
uses independent drafts, explicit self-critique, and revision before aggregation.
This protocol follows the approach in
[Refining Over Resampling: Test-Time Self-Correction for LLM Reasoning](https://arxiv.org/html/2608.05643v1).

The default council roster is **Claude, Codex, Gemini, and Grok**. The server is
**symmetric**: whichever agent launches it is the *host*
(the lead, who synthesizes) and — when
recognized — is **auto-excluded from its own council**, so each host gets the
**other three** as active advisors (three council members plus the host asking the
questions). An unrecognized host gets the full roster (and
may include itself) until you set
`MAGI_COUNCIL_EXCLUDE` (see [Symmetric council](#symmetric-council--host-detection)).

Internally it's an [ACP](https://agentclientprotocol.com) *client* that spawns each
non-host member's ACP server —
[`codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
`agy acp`, `grok agent stdio`, and
[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) —
Direct advisor tools keep one persistent session per member per workspace.
Each council stage uses isolated sessions with explicit previous artifacts.

## Tools

**The council** — fans out to every advisor (the members other than you):

| Tool | Use it to… |
|------|-----------|
| `consult` | run one refinement stage: `draft`, `critique`, or `revise`. Pass each advisor's own artifacts through `previous`. The host follows the same stages and aggregates the revised candidates. `members` selects a subset of active advisors. |

**Ask one advisor directly** (a member's pair appears only when it is in the roster and is not the host):

| Tool | Use it to… |
|------|-----------|
| `ask_codex` / `codex_reply` | a second opinion from Codex, and follow-ups |
| `ask_gemini` / `gemini_reply` | a second opinion from Gemini (Google Antigravity), and follow-ups |
| `ask_claude` / `claude_reply` | a second opinion from Claude (generalist coder) |
| `ask_grok` / `grok_reply` | a second opinion from Grok — live web/X search, current events |
| `grok_generate` | generate an image or short video with Grok, saved into the workspace |

**Structured single-advisor passes** — each takes an optional `member` (default Codex, or `"council"` to fan out to all):

| Tool | Use it to… |
|------|-----------|
| `review_plan` | critique a plan **before** you implement it (verdict / problems / blind spots) |
| `review_diff` | review code changes (pass a diff, or let the advisor read `git diff`) |
| `brainstorm` | get 2–4 alternative approaches with trade-offs + a recommendation |
| `explore` | map an unfamiliar codebase (structure, components, flow, conventions) |

**Delegates** — members as managed coders, working under you (ADR 0018; a member's tool appears only when it is in the roster and is not the host):

| Tool | Use it to… |
|------|-----------|
| `delegate_codex` | hand Codex an implementation task on its own named session (default mode `agent`: sandboxed writes/commands) |
| `delegate_gemini` | hand Gemini an implementation task on its own named session (`agy acp` modes: `default` / `accept-edits` / `auto` / `plan`) |
| `delegate_claude` | hand Claude an implementation task (default mode `auto`: classifier-judged permissions) |
| `delegate_grok` | hand Grok an implementation task (no ACP modes; may write without asking — review its diff) |

Each named delegate is a **separate session** from the member's advisor, so several can
work concurrently — issue parallel tool calls with different `name`s, and partition the
tree between them in the task text. Re-call with the same `name` to steer that delegate
on its live context. Delegates report back: outcome, files changed, verification, blockers.

**Shared:**

| Tool | Use it to… |
|------|-----------|
| `permit` | allow/deny a permission a member or delegate raised mid-turn, then resume it (pass `member`, plus `delegate` for a delegate session) |
| `reset` | drop **all** members' accumulated context, dismiss all delegates, and start fresh sessions |
| `status` | report the resolved host, the active council, live delegates, and each session's health |
| `available_councilors` | list all members; start active advisors if needed and report ACP model, reasoning-effort, **and permission-mode** selector values |

All tools are **advisory** — the members answer, you decide. A member's direct
tools (`ask_*`/`*_reply`) appear **only when that member is in the roster and is
not the host**. The council and the structured tools are always present and target
the active advisors.

### Symmetric council & host detection

The council is **symmetric** — Claude, Codex, Gemini, or Grok can host it. On MCP
`initialize`, the server reads the connecting client's identity and **excludes that
member** (the host) from the roster, leaving the active advisors. Resolution order:

1. **`MAGI_COUNCIL_EXCLUDE`** (`claude`|`codex`|`gemini`|`grok`, startup only) — explicit, wins.
2. **`clientInfo.name`** sent at `initialize` — matched against those four ids (including `antigravity` / `agy` for `gemini`).
3. **unknown** — if neither resolves, the full roster participates (one may be
   the host). `status` and `consult` flag this, so an unrecognized host knows it
   can set the env var to exclude itself.

After initialization, the server removes tools for the host and for
members outside the roster. Every handler also guards at call time, so a stale
client cannot bypass the roster or make the host consult itself. **Giving other agents the council** is just registering this server in their
MCP config — see [Other agents](#giving-other-agents-the-council).

### Debate, not one-shot

The single-advisor tools (`ask_codex`/`ask_gemini`/`ask_grok`/`ask_claude`, `review_plan`,
`review_diff`, `brainstorm`) frame each exchange as a short debate: the advisor
pushes back, and ends every reply with a `VERDICT: CONSENSUS — …` or
`VERDICT: OPEN — …` line. When it's `OPEN`, push back with that advisor's reply
tool (same persistent session, so the thread is kept) and drive toward consensus —
keep it to ~3 turns.

### The Magi council (`consult`)

**Independent refinement is the default council protocol.** We adopt the paper's
breadth-and-depth principle: preserve separate candidates, then critique and repair
each candidate before aggregation. This gives each stage an explicit purpose and
keeps early agreement from replacing independent evaluation.

The host drives one stage per tool call. Finish the host's own draft, self-critique,
and revision before the first call. Keep that candidate unchanged until aggregation,
so advisor drafts cannot influence the host's independent refinement:

1. **Draft.** Call `consult` with `phase: "draft"` (the default). Supply the question
   and neutral task context. Each advisor produces an independent candidate.
2. **Critique.** Call with `phase: "critique"`. Put each advisor's draft in
   `previous[member].candidate`. Each advisor checks only its own candidate for
   concrete errors, unsupported assumptions, and counterexamples.
3. **Revise.** Call with `phase: "revise"`. Keep each candidate and add its own
   critique in `previous[member].critique`. Each advisor repairs supported errors
   and preserves valid parts. An unchanged answer is allowed.
4. **Aggregate.** Combine the revised advisor candidates with the host's revised
   candidate. Use repository evidence and task checks. Use plurality only for
   comparable normalized answers. Resolve ties with evidence and report unresolved
   differences. Agreement alone does not establish correctness.

Each stage starts a fresh session per advisor and disposes it afterward. The server
passes only that advisor's `previous` entry. Repeat the question, neutral context,
member selection, models, and efforts across stages. Do not put host or peer
positions in shared context. Missing required artifacts fail before any advisor is
called. Exclude failed advisors from subsequent stages; errors are not candidates.

For example, one advisor's revision call has this shape:

```json
{
  "question": "The original task",
  "phase": "revise",
  "members": ["claude"],
  "previous": {
    "claude": {
      "candidate": "Claude's draft",
      "critique": "Claude's critique of that draft"
    }
  }
}
```

One refinement cycle takes three calls. Choose a budget before starting. More
depth means another critique/revise pair on each participant's latest candidate.
The host remains a participant and controls the budget. It is never spawned as
its own advisor. `my_take` and `fresh` are removed from `consult`; isolation is
required for every stage. Direct advisor conversations retain their existing
persistent sessions.

This is an adaptation of the paper, not an exact reproduction. We use different
models as participants and task-specific host aggregation instead of eight
same-model rollouts and unconditional answer voting. The paper evaluates math
reasoning. Our [local spike](research/refinement-spike/RESULTS.md) found no accuracy
difference because both protocols solved every task in their initial drafts. We
adopt the explicit refinement structure without claiming a measured coding gain.
This replaces the agreement-driven stopping rule in ADR 0016 while retaining host
participation.

### Model and effort selection

Call **`available_councilors`** to see the ACP model and reasoning-effort selector
values reported by the active advisors. Use the value at the start of each choice
row, not the display label. For example, Claude may report model values like:

```text
default
opus
fable
sonnet
haiku
```

Then pass **`models`** and/or **`efforts`** to choose per-member models and
reasoning efforts for a council fan-out:

```json
{
  "members": ["claude"],
  "models": { "claude": "opus" },
  "efforts": { "claude": "high" },
  "question": "Review this risky design decision."
}
```

Single-advisor tools take **`model`** and **`effort`** instead:

```json
{
  "model": "sonnet",
  "effort": "low",
  "question": "Give me a quick second opinion."
}
```

Model and effort selection are ACP session-level. On direct advisor sessions they
remain until changed or `reset`. For `consult`, they apply only to the current
stage; repeat them in the next stage. If a member does not report the requested selector, or you pass an
unavailable value, the tool returns a readable member-specific error instead of
guessing a fallback. Use Opus/high effort for high-leverage reviews; keep
Sonnet/Haiku and lower effort for routine checks so the council does not
silently eat the expensive budget.

It runs members **concurrently** and **atomically** — every advisor's turn fans out
at once (each on its own session), rendered back in member order, as a single tool
call with no permit round-trips. A council turn is **read-only**: members may read files and
search/fetch to ground their answers. Codex uses native read-only shell inspection
in its restricted mode. Write and command approval requests are
auto-denied (and surfaced as a `⚠️ blocked in council mode: …` line, so a
grounded-looking answer can't hide a quietly-denied action). Each member is
handled independently, so if one is unavailable you still get the others.
Grok's web/X search is not a guardian action, so it works in council mode.

The structured tools (`review_plan`/`review_diff`/`brainstorm`/`explore`) also take
**`member: "council"`** to fan out one round to every advisor (independent panel,
no multi-round deliberation). `review_diff` with `member: "council"` requires an
explicit `diff` so all advisors receive the same changes. A single-advisor review
can inspect `git diff` through its native restricted tools or a permit.
For **image/video generation**, use
`grok_generate`. It writes a file, which read-only council mode would block.

### Permission modes (advisors restricted, delegates native)

Members expose their own permission modes over ACP (codex: `read-only` / `agent` /
`agent-full-access`; claude: `auto` / `default` / `acceptEdits` / …; gemini:
`default` / `accept-edits` / `auto` / `plan`; Grok reports no per-session mode selector),
discovered at session start like models and efforts — `available_councilors` lists them.
**Advisor sessions are pinned to restricted modes where verified** (codex →
`read-only`, claude → `default`, gemini → `default`) so an agent's permissive default can't self-approve writes behind the
guardian's back; if a pin can't apply, `status` shows a ⚠️ warning. **Delegate
sessions use the member's native mode** — the agent's default, or a per-call
`mode` (sticky for that delegate's session). Whatever a mode still escalates
(network, out-of-workspace paths) pauses for the host via `permit` — the host
stays the guardian for risky actions. But the permit fallback only gates what an
agent chooses to surface. Codex ACP 2.1.1 restores approval requests in `read-only`
mode. `agy acp` `default` mode follows the user's Antigravity CLI permission settings. Grok has been observed writing workspace files without asking. Verify mode
behavior when updating a harness, and review a delegate's diff.

### Permissions: the host is the guardian

When a member wants to do something guardian doesn't auto-allow, the turn **pauses
and hands the decision back to the host** — no static allowlist, no human prompt.
The tool returns `🔐 <member> paused … <what it wants>`; the host judges whether it's
reasonable and calls `permit allow|deny`, which resolves the held-open request
and resumes the same suspended turn. Only the cheap, safe cases are auto-allowed
without asking: reads and searches **inside** the workspace. Everything else —
commands, writes, network, out-of-workspace reads — comes back to the host. The
`ALLOW_*` flags downgrade a whole category from "ask" to "auto-allow".

All advisors share this guardian. Since each has its own session, **more than one
can be paused at once** (e.g. an advisor and a delegate); `permit` takes an
optional **`member`** (`claude`|`codex`|`gemini`|`grok`) — inferred
when only one is pending, required when several are. (The Magi council never
suspends — it runs read-only, resolving permissions inline — so it never leaves a
pending permit.)

The server also advertises a **read-only client filesystem** (ACP
`fs/read_text_file`), scoped to the workspace (or anywhere with
`MAGI_COUNCIL_ALLOW_EXTERNAL_READS`). This provides a read path for adapters that
use it. Codex ACP 2.1.1 does not expose it as a tool; Codex uses native shell reads.
The server never advertises `writeTextFile`.

### Running out of usage

Any member can hit usage/rate limits. When a member can't start or its turn fails,
the tool returns a readable message instead of a hard error — and a
quota/rate-limit/credit failure is flagged as "looks out of usage / over quota"
with how to recover. In the council, one member running out still returns the others.

### Streaming & cancellation

Turns stream live: the member's text, its reasoning (a `💭 …` thinking view), and a
`↳ …` activity trail are sent as MCP progress notifications, so you can watch
(and steer between turns). In the council, each voice's stream is prefixed with
the member name. The reasoning stream doubles as a heartbeat — the MCP
client resets its request timeout on progress, so forwarding the thinking
keeps a long, silently-reasoning turn from being cancelled by the client. Cancel
a turn and the member is told to stop (`session/cancel`); if it ignores the cancel, a
short grace later the turn is hard-stopped and the subprocess respawned, so it
can't wedge the queue. The turn timeout is an **idle** timeout: it fires only
after `MAGI_COUNCIL_TURN_TIMEOUT_MS` of *silence* (no text, reasoning, or
tool-call output), and the clock resets on every chunk — so a turn that keeps
streaming is never cut off, however long it runs, and you keep its partial output
instead of losing it. Pass a per-call `time` (seconds) to any tool to widen that
idle window for a single big review/exploration. (The wait for a `permit`
decision is **not** timed.) If your client caps tool calls more tightly, raise
its timeout too — for Claude Code, `MCP_TOOL_TIMEOUT` (e.g. `600000`); `consult`
runs every advisor concurrently in one round, so it benefits from a generous cap.
The tool result stays focused on the member's answer plus a one-line footer
(latency and tokens); the full play-by-play goes to the debug log.

### Sessions & reset

The server keeps **one persistent session per member per workspace** so each
accumulates context across calls (a collaborator, not a stateless oracle). That
context outlives the host's `/clear` — the MCP server isn't restarted then — so
without help the next conversation would land on members that still remember the
last one. `reset` clears **all** members and dismisses all delegates. Two ways to clear it:

- **Automatic, on `/clear`** — install the `SessionStart` hook below. It writes
  the new session id to a per-workspace nonce file; the server notices the change
  on its next turn, drops the members' sessions, and dismisses all delegates, so
  everything starts fresh alongside the host. (`compact`/`resume`/`startup` are intentionally left alone.) **This
  hook is Claude Code-specific** — for any other host, use the manual `reset`
  tool instead.
- **Manual** — call the `reset` tool any time: switching to an unrelated task,
  when a member's context has grown stale over a long session, or to clear a wedged
  turn. It's also the fallback if the hook isn't installed.

Note the asymmetry: an advisor's context lives only as long as the server process,
but the host's is persisted. After a host **resume**, a crash-respawn, or a reboot,
advisors start empty while the host remembers — so a follow-up reply may land on an
advisor that no longer has the thread. Re-establish context (or `reset` and start clean) if so.

## Requirements

- [Bun](https://bun.sh)
- A working Codex login (`codex login`, or set `OPENAI_API_KEY`). `codex-acp` is
  fetched on demand via `bunx`, pinned to an exact version (it releases near-daily
  and drives Codex's experimental `codex app-server` protocol underneath — the pin
  keeps both sides in lockstep); bump the version in `src/config.ts` deliberately.
- Gemini uses the Antigravity CLI (`agy`) on your `PATH` (`agy acp`). Run
  `agy acp --login` (or launch `agy`) to authenticate.
- Grok uses the [Grok CLI](https://x.ai) on your `PATH`. Run `grok login` and
  confirm that the account has available usage.
- For Claude's seat on the council (only when the host **isn't** Claude):
  [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  fetched on demand via `bunx`, plus a working Claude login / `ANTHROPIC_API_KEY`.
  The pinned adapter uses Claude Agent SDK 0.3.287. Call `available_councilors`
  to inspect the models available to the account.
  The spawned Claude process disables Claude's native advisor tool because the
  council supplies the second opinion.
  **Experimental** — disable by setting
  `MAGI_COUNCIL_CLAUDE_ACP_COMMAND` to a no-op or excluding Claude.

Each member is **lazy** — only spawned when one of its tools (or a
council turn that brings it in) is actually called. With the usual Claude host, the
Claude member never spawns.

```bash
bun install
```

## Register with Claude Code

```bash
claude mcp add magi-council -- bun run /ABS/PATH/magi-council-mcp/src/index.ts
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "magi-council": {
      "command": "bun",
      "args": ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"],
      "env": { "MAGI_COUNCIL_WORKSPACE": "/ABS/PATH/your-project" }
    }
  }
}
```

### Reset the council on `/clear` (recommended)

Add a `SessionStart` hook so clearing the Claude conversation also clears the
members' context (see [Sessions & reset](#sessions--reset)). In `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bun run /ABS/PATH/magi-council-mcp/hooks/session-reset.ts" }
        ]
      }
    ]
  }
}
```

The hook runs on every session start but only acts on `source == "clear"`; for
other sources it's a no-op. It keys the nonce file on the hook's `cwd`, which must
match the server's workspace (the default — `MAGI_COUNCIL_WORKSPACE` unset). Two
Claude windows in the **same** workspace share the nonce, so a `/clear` in one
resets the members for both; that only discards advisory context, never corrupts it.

### Giving other agents the council

Because the host is auto-excluded, the same server works for **Codex, Gemini (`agy`), or Grok**
as host — register it in their MCP config the same way. The server tries to detect
the host from the client's `initialize` identity, but detection isn't guaranteed,
so **set `MAGI_COUNCIL_EXCLUDE` explicitly** for non-Claude hosts, e.g. in a Codex
host's MCP server env:

```json
{ "command": "bun", "args": ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"],
  "env": { "MAGI_COUNCIL_EXCLUDE": "codex", "MAGI_COUNCIL_WORKSPACE": "/ABS/PATH/your-project" } }
```

With the default roster, that Codex host gets Gemini + Grok + Claude as its council
(`ask_gemini`, `ask_grok`, `ask_claude`, `consult`). Check
`status` to confirm the resolved host and active council.

For Antigravity CLI (`agy`), register it with:

```bash
agy mcp add \
  --env MAGI_COUNCIL_EXCLUDE=gemini \
  --env MAGI_COUNCIL_WORKSPACE=/ABS/PATH/your-project \
  magi-council -- /ABS/PATH/TO/bun run /ABS/PATH/magi-council-mcp/src/index.ts
```

For Codex CLI/IDE specifically, either add it with the CLI:

```bash
codex mcp add magi-council \
  --env MAGI_COUNCIL_EXCLUDE=codex \
  --env MAGI_COUNCIL_WORKSPACE=/ABS/PATH/your-project \
  -- /ABS/PATH/TO/bun run /ABS/PATH/magi-council-mcp/src/index.ts
```

Or put this in `~/.codex/config.toml` (or a trusted project `.codex/config.toml`):

```toml
[mcp_servers.magi-council]
command = "/ABS/PATH/TO/bun"
args = ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 600

[mcp_servers.magi-council.env]
MAGI_COUNCIL_EXCLUDE = "codex"
MAGI_COUNCIL_WORKSPACE = "/ABS/PATH/your-project"
```

Then restart Codex or start a new session and run `/mcp` to confirm the server is
connected. Use `command -v bun` to find the Bun path; an absolute command avoids
startup failures when Codex's MCP launcher does not inherit your interactive shell
`PATH`.

`MAGI_COUNCIL_WORKSPACE` is optional: if omitted, the server scopes members to the
MCP process cwd. For a project-specific config you can instead set
`cwd = "/ABS/PATH/your-project"` on `[mcp_servers.magi-council]` and omit the
workspace env var.

## Configuration (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAGI_COUNCIL_WORKSPACE` | cwd | Absolute path the members are scoped to; the base for every guardian check. |
| `MAGI_COUNCIL_MEMBERS` | `codex,gemini,grok,claude` | Comma-separated council roster. Member ids: `claude`, `codex`, `gemini`, and `grok`. Input order does not change canonical voice order. |
| `MAGI_COUNCIL_EXCLUDE` | (auto) | Force the host member to exclude (`claude`\|`codex`\|`gemini`\|`grok`). Wins over clientInfo detection; recommended for non-Claude hosts. |
| `MAGI_COUNCIL_CLAUDE_ACP_COMMAND` | `bunx @agentclientprotocol/claude-agent-acp@0.86.0` | How to launch Claude's ACP server (used only when Claude isn't the host). |
| `MAGI_COUNCIL_CODEX_ACP_COMMAND` | `bunx @agentclientprotocol/codex-acp@2.1.1` | How to launch Codex's ACP server. |
| `MAGI_COUNCIL_GEMINI_ACP_COMMAND` | `agy acp` | How to launch Gemini's ACP server (Google Antigravity CLI). |
| `MAGI_COUNCIL_GROK_ACP_COMMAND` | `grok agent stdio` | How to launch Grok's ACP server. |
| `MAGI_COUNCIL_ALLOW_EXTERNAL_READS` | off | Let a member read outside the workspace + use network fetch. |
| `MAGI_COUNCIL_ALLOW_WRITES` | off | Let a member edit/delete/move files inside the workspace. |
| `MAGI_COUNCIL_ALLOW_COMMANDS` | off | Let a member run shell commands. |
| `MAGI_COUNCIL_TURN_TIMEOUT_MS` | `600000` | Idle timeout: abort a turn after this long of *silence* (clock resets on every chunk). Override per call with the `time` arg (seconds). |
| `MAGI_COUNCIL_LOG` | off | Append a full per-turn JSONL debug log to this path. |

### Guardian mode

By default the server runs in **guardian mode**: a member may only *read and search
inside the workspace* without asking. Everything else — writes, network fetches,
command execution, and reads that escape the workspace root — isn't auto-refused;
the turn **pauses and hands the request to the host** to allow or deny (see
[Permissions: the host is the guardian](#permissions-the-host-is-the-guardian)), and
every decision is logged. So `review_diff` can run `git diff` the moment you
allow it — there's no static command allowlist to outwit (see ADR 0003). The
`ALLOW_*` flags downgrade a whole category (external reads + fetch, writes, or
commands) from "ask the host" to auto-allow; the policy is a single pure function
in [`src/permissions.ts`](src/permissions.ts).

## Layout

```
src/config.ts       env → Config + per-member MemberSpecs + host-exclude override
src/permissions.ts  guardianDecision — the pure permission policy
src/council.ts      pure council-selection logic (selectCouncil)
src/prompts.ts      host-parameterized prompts per tool (Codex/Gemini/Claude/Grok, magi)
src/session.ts      AcpSession — ACP client: spawn a member, selector config, persistent session, streaming ask()
src/reset.ts        per-workspace reset-nonce path (shared by server + hook)
src/log.ts          per-turn debug log (stderr summary + optional JSONL file)
src/index.ts        MCP server: member sessions, host detection + tool gating, the Magi council, delegates
hooks/session-reset.ts  SessionStart hook: reset members on the host's /clear (Claude Code)
test/fake-acp.ts    a scripted ACP agent subprocess for tests (behavior by --scenario)
test/*.test.ts      bun test: AcpSession lifecycle (E2E vs the fake) + pure council logic
docs/adr/000*.md    design decisions
```

## Tests

```bash
bun test       # deterministic, no network and no real model calls (a few seconds)
bun run typecheck
```

`test/session.test.ts` drives `AcpSession` end-to-end against `test/fake-acp.ts` — a
real ACP *agent* subprocess scripted by `--scenario` — through the genuine
spawn → prompt → permission → cancel path, covering suspend/resume, reset, idle
timeout, external cancel, crash-fails-fast, gate serialization, and nonce reset.
`test/council.test.ts` unit-tests the pure council-selection logic in `src/council.ts`.
