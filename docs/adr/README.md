# ADR index

*ADRs here are deliberately minimal (often one paragraph); this hand-maintained index should be updated with each new ADR.*

| ADR | Title | One-line gist |
|-----|-------|---------------|
| [0001](0001-codex-fusion-mcp.md) | codex-fusion-mcp design | Original Codex-only MCP: spawn one persistent `codex-acp` advisor per workspace, with safe-by-default guardian policy later revised by 0003. |
| [0002](0002-interactive-debate.md) | interactive debate, streaming, and focused output | Turn one-shot Codex calls into streamed debate/reply loops with cancellation, timeout, focused output, and startup recovery. |
| [0003](0003-claude-judged-permissions.md) | Claude judges permissions | Replace brittle command allowlists with host-mediated `permit` for non-obvious permissions, while auto-allowing safe workspace reads. |
| [0004](0004-reset-on-clear.md) | Reset Codex when the Claude session clears | Add manual `reset` plus a Claude `/clear` nonce hook so the advisor session clears when the host context clears. |
| [0005](0005-idle-turn-timeout.md) | Turn timeout is idle, not wall-clock | Make turn timeout an idle watchdog reset by real progress, with per-call `time`, instead of a fixed wall-clock cap. |
| [0006](0006-grok-magi-council.md) | Add Grok as a second council member (the Magi) | Add the original Grok surface; its session/council design was reshaped by 0007/0008. |
| [0007](0007-symmetric-council-host-exclusion.md) | Symmetric council: Claude as a member, host auto-excluded | Add Claude as a member, auto-exclude the detected host, and make the remaining members equal advisors. |
| [0008](0008-tool-surface-and-deliberation.md) | Symmetric tool surface + council deliberation | Rename around `consult`, add symmetric `ask_*` and per-member structured tools, and add autonomous multi-round deliberation later superseded by 0016. |
| [0009](0009-lifecycle-hardening-and-test-harness.md) | Lifecycle hardening + a deterministic ACP test harness | Fix reset, hard-stop, crash, and read-containment gaps, then cover `AcpSession` with a fake-ACP integration harness. |
| [0010](0010-council-convergence-parallel-fresh.md) | Council: self-reported convergence, parallel advisors, fresh sessions | Replace verdict-string convergence with `CHANGED`, run advisors in parallel, and add `fresh`; multi-round pieces later superseded by 0016. |
| [0011](0011-council-memory-magi-md.md) | Council memory in a workspace `MAGI.md` (proposed) | Proposed, deferred, and not implemented: opt-in durable council notes as inspectable shared memory across respawns/resumes. |
| [0012](0012-round-2-hardening.md) | Round-2 hardening: honest quorum, decoupled startup, safe concurrency | Tighten quorum, startup timeout, shared progress, symlink guarding, stale-startup handling, disposal, and test reliability. |
| [0013](0013-disagreement-matrix.md) | Targeted deliberation via a disagreement matrix (parked) | Parked by 0014: a targeted disagreement-matrix prototype was cut as duplicative, untested, and biased by its scribe. |
| [0014](0014-simplification-and-concurrency-hardening.md) | Simplification pass + concurrency hardening (council quality gate) | Cut 0013, keep `index.ts` as a deep module, and fix queued-turn, abandoned-turn, stale-child, and shutdown races. |
| [0015](0015-council-member-selector.md) | Council member selector | Add `members` to pick an active advisor subset for `consult`; host self-inclusion was cut and redirected to 0016. |
| [0016](0016-host-mediated-deliberation.md) | Host-mediated deliberation (remove autonomous rounds) | Remove autonomous `rounds`/`until_settled`: `consult` is one round, and the host drives follow-up rounds with `my_take`, superseding multi-round 0008/0010. |
| [0017](0017-acp-model-selection.md) | ACP model selection | Discover member model selectors via `available_councilors` and apply per-call `model`/`models` at session level. |
| [0018](0018-delegate-mode.md) | Delegate mode: members as managed coders | Add named `delegate_*` coder sessions with native ACP modes, concurrent delegates, explicit permit routing, and reset cleanup. |
| [0019](0019-add-optional-copilot-member.md) | Add an optional Copilot member | Superseded by 0020: added optional Copilot (`--acp`) outside the default roster, keep `MAGI_COUNCIL_MEMBERS` roster filtering. |
| [0020](0020-add-gemini-member.md) | Replace Copilot with Gemini via `agy acp` | Remove Copilot and add Gemini via `agy acp` to the default roster so each recognized host gets the other three members as its council. |
