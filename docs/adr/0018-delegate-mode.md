# 0018 — Delegate mode: members as managed coders

**Context.** Every tool so far treats members as read-mostly *advisors* (ask_X /
consult / review_*): opinions in, no side effects out. New need: the host acts as a
**manager** and hands members real implementation tasks — with multiple delegates
working at once. Designed with Codex (consensus over 3 rounds); permission posture
verified by live ACP probes against codex-acp, claude-agent-acp, and grok.

**Decision.**

- **Tools**: per-member `delegate_codex` / `delegate_grok` / `delegate_claude`
  (removed for the host via `memberTools`, like `ask_X`). Args: `task`, `context?`,
  `name?` (delegate instance id, default = the member), `mode?`, `model?`, `time?`.
- **Sessions**: delegates run on their **own `AcpSession`s**, keyed `(member, name)`
  in a separate map from the persistent advisor sessions — advisor debates stay
  unpolluted, and each delegate has its own subprocess + turn gate, so concurrency
  falls out of the existing machinery. "Multiple at once" = the host issues
  **parallel MCP tool calls**; calls are blocking with streaming progress, exactly
  like `ask_X`. **No async job registry** — it would duplicate cancellation, result
  retention, pending-permission, and reset lifecycle that `AcpSession` already owns,
  without fixing the no-push-notification UX.
- **Permissions are the agent's native ACP modes**, not a new guardian layer.
  Agents expose their permission modes over ACP (codex: `read-only` / `agent` /
  `agent-full-access`, default `agent` — its auto mode, sandboxed writes+commands
  with internal Guardian Review; claude: `auto` / `default` / `acceptEdits` /
  `plan` / `dontAsk` / `bypassPermissions`, default `auto` — classifier-judged;
  grok: none). Both mirror them as a `category: "mode"` config option, so the
  ADR 0017 model-selection machinery generalizes: **discover choices at session
  start, validate requests against them, set via `setSessionConfigOption`** —
  session-level and sticky, like `model`. `available_councilors` and `status`
  report the mode selector alongside models. A delegate defaults to the agent's
  own default mode (codex `agent`, claude `auto`); the manager overrides per call
  with `mode`. Grok has no selector: requesting a mode errors listing none, and
  Grok delegates keep the guardian→permit flow for writes/commands.
- **Advisor sessions get pinned to restricted modes** (codex → `read-only`,
  claude → `default`) at session start — skip with a visible `status` warning if
  the id isn't among the discovered choices, never fail startup. Probes showed the
  agents' *defaults* (codex `agent`, claude `auto`) self-approve writes without our
  `requestPermission` guardian ever seeing them, which silently voided the ADR 0003
  premise for advisors; pinning restores it. Verified live: claude `default`
  surfaces writes as permission requests (our deny blocked the write); codex
  `read-only` runs safe commands (`git status`, `git diff`) without round-trips.
  **Known limitation, verified live:** codex's internal Guardian Review can
  self-approve a workspace write even in `read-only` mode without surfacing a
  request — for Codex, modes steer but are not a hard boundary; our guardian
  remains the backstop only for what codex chooses to surface.
- **`permit` scope shrinks accordingly**: it applies only to requests the agent
  still surfaces (claude `default`, grok, codex escalations). A delegate in a
  native auto mode mostly won't round-trip — that's the point.
- **Steering**: re-call `delegate_X` with the same `name` — the new turn lands on
  the live session with its accumulated context. The initial call gets full
  implementation-agent framing plus a report contract (what changed, files touched,
  tests/commands run, blockers); follow-ups get a short steering prompt (mirrors the
  `ask_X` / `X_reply` split). No `delegate_reply` tool.
- **Suspended-turn safety**: a same-name call while that delegate awaits a `permit`
  is **refused** in `index.ts` (decide the permission first) — `ask()`'s abandon
  path is fine for advisors but must not silently kill a coder's half-done turn.
- **Routing & lifecycle**: `permit` addresses an exact delegate (member + name) and
  errors on ambiguity; `status` grows a delegates section (mode + subprocess
  liveness visible, so accumulation can't hide); `reset` disposes and deletes all
  delegates. No per-delegate `dismiss` in v1 — extra surface before real pressure.
  Names are validated (slug, bounded length) and the delegate count capped, so
  typos can't grow the subprocess map unbounded.
- **No git-worktree isolation in v1** — the manager partitions work between
  concurrent delegates in the task text. Worktrees later if collisions hurt.

**Why.** Blocking-parallel matches every existing shape in the server (blocking
tools + progress streaming, `Promise.all` fan-out, per-member tools with host
removal, session-level selector machinery), so delegate mode is mostly new prompts
+ a session map + generalizing one selector — not a second lifecycle or permission
system. Native modes beat a bespoke write-scope guardian: the agent's own sandbox
is the enforcement point, and our probes showed a client-side guardian can't gate
what the agent never surfaces anyway.

**Consequences.** Each named delegate holds a live subprocess until `reset`. A
delegate paused on a permission blocks only itself; others keep running. Concurrent
delegates share one working tree — the manager partitions work, and overlapping
edits are its mistake to avoid. Trust boundaries are per-member and explicit:
claude modes enforce through our permit loop, codex modes are steering plus its own
guardian, grok has no modes at all.
