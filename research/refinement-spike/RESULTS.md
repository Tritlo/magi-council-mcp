# Results: 2026-10-05

The spike found no quality advantage for independent refinement. Both protocols
passed all 30 final checks. Every initial draft already passed its 15 checks.
No checked behavior improved or regressed during revision. These tasks were too
easy for this pair to measure recovery. The project adopts independent refinement
for its explicit separation of candidate generation, critique, revision, and
aggregation. This is a design choice; the spike does not establish a quality gain.
See the [current council protocol](../../README.md#the-magi-council-consult).

Adoption verification: all 23 lifecycle/council checks pass, including artifact
isolation, missing-input rejection, and exclusion of incomplete responses. The
live Opus/Astra [three-stage smoke](mcp-refinement-smoke.json) passes. The historical
experiment uses a frozen baseline prompt and its recorded measurements are unchanged.

The run used GPT-6 Astra and Opus 5.5 at medium effort. It completed 36 calls.
All 20 recorded implementation artifacts also passed strict TypeScript checking.
See the [design](README.md), [raw run](runs/2026-10-05),
[summary](runs/2026-10-05/summary.json), and
[type checks](runs/2026-10-05/typecheck.json).

| Task | Protocol | Final checks | Wall seconds | Summed call seconds | Reported tokens |
| --- | --- | --- | ---: | ---: | ---: |
| Selector resolution | Baseline | 15/15 | 174.652 | 173.419 | 305,701 |
| Selector resolution | Refinement | 15/15 | 128.006 | 191.931 | 281,879 |
| Streaming assembly | Baseline | 15/15 | 126.985 | 125.956 | 292,315 |
| Streaming assembly | Refinement | 15/15 | 82.637 | 131.335 | 273,394 |

Across both tasks, refinement used 555,273 reported tokens versus 598,016 for the
baseline. Wall time was 210.643 seconds versus 301.637 seconds. Summed call time
was higher for refinement: 323.266 seconds versus 299.375 seconds. Parallel stages
explain part of the wall-time difference. These are single observations with
different prompt histories and uncontrolled service load and caching. They do not
establish an equal-compute or monetary-cost advantage. All nine calls ran even
after agreement; production early stopping could change the comparison.

## Harness Compatibility

The repository started at `90077205db4ee0c600041594ac244e83ebaf5fd7` after a successful
`git pull --ff-only`. Changes are on `codex/harness-refresh-refinement-spike`.

| Component | Previous | Checked version | Result |
| --- | --- | --- | --- |
| Codex ACP | 1.1.0 | 2.1.1 | Astra model/effort selection, file read, denied write, and MCP consult passed |
| Claude ACP | 0.73.0 | 0.86.0 | Opus model/effort selection, file read, denied write, and MCP consult passed |
| Copilot CLI | 1.0.73 | 1.0.91 | Startup reached service; account returned HTTP 403 |
| Grok CLI | 1.0.30 | 1.0.46 | Login, Grok 4.7 selection inventory, and file read passed; write enforcement failed |
| ACP SDK | 1.0.0 | 1.7.0 | Type check and all 21 existing lifecycle/council checks passed |

The installed Codex CLI 0.160.0 and Claude Code 2.1.289 already matched their
registry releases. The council uses the runtimes bundled with its pinned ACP
adapters. A global CLI version does not establish the adapter runtime version.

Current Codex ACP does not expose the ACP client filesystem as a model tool.
The old council instruction prohibited its native shell reader. Council prompts
now permit native read-only inspection. Write and command approval requests are
still denied. Both live write probes reached the guardian and were denied.
Codex ends a denied write turn with `cancelled`; Claude reports the denial with
`end_turn`. The harness smoke accepts these outcomes only with an observed denial
and an absent target file.

Codex also reports sandbox permission profiles in `rawInput.permissions` and
`rawInput.additionalPermissions`. Permission descriptions now include those
profiles, paths, and explanatory text so the host can inspect the requested scope.
The existing permission lifecycle check covers both profile forms.

Evidence: [inventories](inventory.json), [harness smoke](harness-smoke.json), and
[MCP smoke](mcp-smoke.json). The saved smoke used a shared denied-write path; no
member created it. Future runs use distinct member paths to avoid interference.

After login, Grok 1.0.46 started and answered file-read prompts with Grok 4.7.
It created the disposable write-probe file without an ACP permission request.
Both `grok agent stdio` and `grok --permission-mode default agent stdio` showed
this behavior. The [Grok recheck](harness-smoke-grok.json) records the explicit-mode
attempt. The council guardian cannot deny actions that Grok does not submit for
approval. Grok remains in the default roster, but its read-only boundary is not
enforced by this permission path.

Copilot is not verified for live prompt turns. It reports
`403 "unauthorized: not authorized to use this Copilot feature"`.
The active chat's MCP process still has the previous pins
loaded. Reconnect the MCP server to load the update. Resetting advisor sessions
does not reload the server code.

Primary references:

- [Codex ACP 2.1.1](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.1.1)
- [Claude ACP releases](https://github.com/agentclientprotocol/claude-agent-acp/releases)
- [Copilot ACP documentation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
