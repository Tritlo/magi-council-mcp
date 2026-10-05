#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, MEMBER_IDS, type MemberId, type MemberSpec } from "./config.ts";
import { selectCouncil } from "./council.ts";
import { resetNonceFile } from "./reset.ts";
import {
  AcpSession,
  NoPendingPermission,
  selectorLabel,
  selectorPluralLabel,
  type AskOptions,
  type AskResult,
  type MemberInventory,
  type SelectorCategory,
  type SelectorInventory,
  type SessionStatus,
  type TurnOutcome,
} from "./session.ts";
import {
  askClaudePrompt,
  askCodexPrompt,
  askCopilotPrompt,
  askGrokPrompt,
  brainstormPrompt,
  delegatePrompt,
  delegateSteerPrompt,
  explorePrompt,
  grokGeneratePrompt,
  magiAdvisorPrompt,
  replyPrompt,
  reviewDiffPrompt,
  reviewPlanPrompt,
  type CouncilCandidate,
  type CouncilPhase,
} from "./prompts.ts";

// ACP agents can emit extension notifications and stray responses the SDK can't
// route; it logs each via console.error as "Error
// handling notification" / "Got response to unknown request". They're harmless
// protocol cross-talk but spam the MCP logs, so drop just those lines and pass
// everything else through.
const ACP_NOISE = ["Error handling notification", "Got response to unknown request"];
const baseConsoleError = console.error.bind(console);
console.error = ((...args: unknown[]): void => {
  if (typeof args[0] === "string" && ACP_NOISE.some((p) => (args[0] as string).startsWith(p))) return;
  baseConsoleError(...args);
}) as typeof console.error;

const config = loadConfig();
const memberIds = config.memberIds;
const specs: Record<MemberId, MemberSpec> = {
  claude: config.claude,
  codex: config.codex,
  copilot: config.copilot,
  grok: config.grok,
};

/**
 * Restricted permission modes pinned on ADVISOR sessions at start (ADR 0018):
 * advisors deliberate, and the agents' own defaults (codex `agent`, claude `auto`)
 * self-approve writes without our guardian ever seeing a request. Best-effort —
 * skipped with a status warning when an agent doesn't offer the mode. Delegate
 * sessions are NOT pinned; they use the agent's native modes (default or per-call
 * `mode`).
 */
const ADVISOR_MODE: Partial<Record<MemberId, string>> = { codex: "read-only", claude: "default" };
const advisorSession = (id: MemberId): AcpSession =>
  new AcpSession(config, specs[id], { pinnedMode: ADVISOR_MODE[id] });

const sessions: Record<MemberId, AcpSession> = {
  claude: advisorSession("claude"),
  codex: advisorSession("codex"),
  copilot: advisorSession("copilot"),
  grok: advisorSession("grok"),
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// --- host resolution ------------------------------------------------------
// The agent driving the MCP (the client) is the council host and is excluded
// from its own council. Resolution order: MAGI_COUNCIL_EXCLUDE (startup) >
// clientInfo regex > unknown (exclude nobody — all roster members participate, and one
// may be the host). The `source` is surfaced so an unrecognized host knows it can
// set the env var to exclude itself (see status / ask_magi warning).

type HostSource = "env" | "clientInfo" | "unknown";
interface HostResolution {
  /** Member excluded as the host, or undefined when the host is unknown. */
  excluded?: MemberId;
  source: HostSource;
  rawClient?: string;
}
let resolved: HostResolution | undefined;

function detectFromClientInfo(name: string | undefined): MemberId | undefined {
  if (!name) return undefined;
  if (/claude/i.test(name)) return "claude";
  if (/codex/i.test(name)) return "codex";
  if (/copilot/i.test(name)) return "copilot";
  if (/grok/i.test(name)) return "grok";
  return undefined;
}

function resolveHost(): HostResolution {
  if (resolved) return resolved;
  const rawClient = server.server.getClientVersion()?.name;
  if (config.excludeOverride) {
    resolved = { excluded: config.excludeOverride, source: "env", rawClient };
  } else {
    const detected = detectFromClientInfo(rawClient);
    resolved = detected ? { excluded: detected, source: "clientInfo", rawClient } : { source: "unknown", rawClient };
  }
  return resolved;
}

const isEnabled = (id: MemberId): boolean => memberIds.includes(id);
const isActive = (id: MemberId): boolean => isEnabled(id) && resolveHost().excluded !== id;
const activeIds = (): MemberId[] => memberIds.filter(isActive);
const memberSchema = z.enum(MEMBER_IDS as [MemberId, ...MemberId[]]);
const askToolNames = memberIds.map((id) => `ask_${id}`).join(" / ");
const replyToolNames = memberIds.map((id) => `${id}_reply`).join(" / ");
/** The host's display name for prompt framing (generic when the host is unknown). */
const hostName = (): string => {
  const e = resolveHost().excluded;
  return e ? specs[e].name : "the host agent";
};

/**
 * Resolve which advisor a per-member deliberative tool targets: the requested
 * member if active, else (when none requested) Codex, else the first active
 * advisor. Returns undefined only when a specific inactive member was requested.
 */
function advisorFor(member: MemberId | undefined): MemberId | undefined {
  if (member) return isActive(member) ? member : undefined;
  return isActive("codex") ? "codex" : activeIds()[0];
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** One-line footer for a finished turn: latency, and tokens when reported. */
function footer(result: AskResult): string {
  const parts = [`${(result.ms / 1000).toFixed(1)}s`];
  if (result.usage) parts.push(`${fmtTokens(result.usage.totalTokens)} tok`);
  return `_${parts.join(" · ")}_`;
}

/** Render a finished turn: the member's answer, then a terse one-line footer. */
function renderAnswer(result: AskResult, name: string): ToolResult {
  const body = result.text.length > 0 ? result.text : `_(${name} returned no text)_`;
  const stop =
    result.stopReason === "end_turn"
      ? ""
      : result.stopReason === "timeout"
        ? `\n\n_(${name} went silent — pass a larger \`time\` (seconds) to extend the idle timeout, or narrow the question)_`
        : result.stopReason === "cancelled"
          ? "\n\n_(cancelled)_"
          : `\n\n_(${name} stopped: ${result.stopReason})_`;
  return { content: [{ type: "text", text: `${body}${stop}\n\n${footer(result)}` }] };
}

/** Render whatever a turn produced: an answer, or a permission for the host to judge.
 * `permitRef` is how the host addresses this session in `permit` (defaults to the member). */
function renderOutcome(outcome: TurnOutcome, name: string, permitRef?: string): ToolResult {
  if (outcome.type === "permission") {
    return {
      content: [
        {
          type: "text",
          text:
            `🔐 ${name} paused and needs your permission to continue:\n\n` +
            `    ${outcome.description}\n\n` +
            `Decide whether this is reasonable, then call **permit** with decision \`allow\` or \`deny\` ` +
            `(${permitRef ?? `member \`${name.toLowerCase()}\``}) to resume the turn — ${name} is waiting on the same session.`,
        },
      ],
    };
  }
  return renderAnswer(outcome.result, name);
}

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/** Turn a thrown member error into a readable result, flagging likely out-of-usage. */
function renderMemberError(name: string, err: unknown, loginHint?: string): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const outOfUsage =
    /quota|rate.?limit|\b429\b|too many requests|credit|insufficient|usage limit|out of (usage|credit)|over[ -]?(the )?limit|payment|billing|exhaust/i.test(
      msg,
    );
  const head = outOfUsage
    ? `⚠️ ${name} looks out of usage / over its quota right now.`
    : `⚠️ ${name} couldn't complete the request.`;
  // Append the recovery hint for usage failures, unless the message already has it
  // (startup errors build it in; turn-time failures don't).
  const hint = outOfUsage && loginHint && !msg.includes(loginHint) ? `\n\nTo recover: ${loginHint}.` : "";
  return { content: [{ type: "text", text: `${head}\n\n${msg}${hint}` }] };
}

/** Result for a direct tool whose member is the host (excluded from the council). */
function inactiveResult(id: MemberId): ToolResult {
  if (!isEnabled(id)) {
    return textResult(
      `${specs[id].name} is not in the council roster. Add \`${id}\` to ` +
        "`MAGI_COUNCIL_MEMBERS` and restart magi-council to enable it.",
    );
  }
  const how = resolveHost().source === "env" ? "set by MAGI_COUNCIL_EXCLUDE" : "detected as the host";
  return {
    content: [
      {
        type: "text",
        text: `${specs[id].name} is the council host (${how}) and can't advise itself. Active council: ${activeIds()
          .map((i) => specs[i].name)
          .join(", ")}.`,
      },
    ],
  };
}

/** Last line / tail of the streamed text so far, for a rolling live view. */
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-140);

type Notify = (message: string) => void;

/** A single monotonic progress channel for one MCP tool call. Concurrent council
 * advisors must share *one* of these — MCP progress values are per-token and
 * should increase, so a per-advisor counter would emit duplicate/out-of-order
 * `progress` numbers on the same token. */
function progressNotifier(extra: Extra): Notify {
  const token = extra._meta?.progressToken;
  let progress = 0;
  return (message: string): void => {
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: ++progress, message },
    });
  };
}

/** Streaming hooks that forward a member's output via a (possibly shared) notifier. */
function streamHooks(notify: Notify, prefix = ""): Pick<AskOptions, "onText" | "onThought" | "onActivity"> {
  let acc = "";
  let thinking = "";
  return {
    onText: (chunk) => {
      acc += chunk;
      notify(`${prefix}${tail(acc)}`);
    },
    onThought: (chunk) => {
      thinking += chunk;
      notify(`${prefix}💭 ${tail(thinking)}`);
    },
    onActivity: (note) => notify(`${prefix}↳ ${note}`),
  };
}

/** Start a member turn, streaming progress, honouring cancellation, and reporting errors. */
function ask(
  id: MemberId,
  prompt: string,
  extra: Extra,
  label: string,
  time?: number,
  model?: string,
  effort?: string,
): Promise<ToolResult> {
  const session = sessions[id];
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  return session
    .ask(prompt, { label, signal: extra.signal, timeoutMs, model, effort, ...streamHooks(progressNotifier(extra)) })
    .then((outcome) => renderOutcome(outcome, session.name))
    .catch((err: unknown) => renderMemberError(session.name, err, session.loginHint));
}

/**
 * Optional per-call override of the idle timeout, in seconds. The clock is
 * measured from the member's last output, so an actively-working turn is never
 * cut off; raise this only for big reviews/explorations (or media generation)
 * that may pause for long stretches before producing more output.
 */
const timeField = {
  time: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional idle timeout in seconds for this call, overriding the default. The clock runs from the member's last output, so a turn that keeps streaming is never cut off — raise this for large reviews/explorations or media generation that may go quiet for a while.",
    ),
};

type ModelSelection = Partial<Record<MemberId, string>>;
type EffortSelection = Partial<Record<MemberId, string>>;
const modelValue = z.string().min(1);
const modelField = {
  model: modelValue
    .optional()
    .describe(
      "Optional ACP model selector value/name to use for this member before the turn starts. The selection is session-level and remains until changed or reset.",
    ),
};
const effortField = {
  effort: modelValue
    .optional()
    .describe(
      "Optional ACP thought_level (reasoning effort) selector value/name to use for this member before the turn starts. Values come from available_councilors. The selection is session-level and remains until changed or reset.",
    ),
};
const modelsField = {
  models: z
    .object({ claude: modelValue.optional(), codex: modelValue.optional(), copilot: modelValue.optional(), grok: modelValue.optional() })
    .optional()
    .describe(
      "Optional per-member ACP model selector values/names for a council fan-out, e.g. { codex: \"...\", claude: \"...\" }. Values come from available_councilors.",
    ),
};
const effortsField = {
  efforts: z
    .object({ claude: modelValue.optional(), codex: modelValue.optional(), copilot: modelValue.optional(), grok: modelValue.optional() })
    .optional()
    .describe(
      "Optional per-member ACP thought_level (reasoning effort) selector values/names for a council fan-out, e.g. { codex: \"high\", claude: \"medium\" }. Values come from available_councilors.",
    ),
};
const modeField = {
  mode: modelValue
    .optional()
    .describe(
      "Optional ACP permission-mode value/name for this delegate (values from available_councilors; e.g. codex `agent`, claude `acceptEdits`). Session-level and sticky until changed or reset. Omit for the agent's default.",
    ),
};

const server = new McpServer({ name: "magi-council", version: "0.3.0" });

// Tool handles per member, so the host's direct tools can be removed once known.
const memberTools: Record<MemberId, Array<{ remove(): void }>> = { claude: [], codex: [], copilot: [], grok: [] };

// --- Codex tools ----------------------------------------------------------

memberTools.codex.push(
  server.registerTool(
    "ask_codex",
    {
      description:
        "Ask Codex directly for an independent second opinion on a specific question or decision. Codex debates back; continue with `codex_reply` (cap ~3 turns). For the whole council use `consult`.",
      inputSchema: {
        question: z.string().describe("The specific question or decision to put to Codex."),
        context: z
          .string()
          .optional()
          .describe("Optional background: your current thinking, constraints, or relevant snippets."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ question, context, time, model, effort }, extra) =>
      isActive("codex")
        ? ask("codex", askCodexPrompt(hostName(), question, context), extra, "ask_codex", time, model, effort)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "codex_reply",
    {
      description:
        "Continue the conversation with Codex on the SAME session (it remembers the thread). Push back on its last answer and drive toward consensus — keep the whole debate to ~3 turns.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Codex."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ message, time, model, effort }, extra) =>
      isActive("codex")
        ? ask("codex", replyPrompt(hostName(), message), extra, "codex_reply", time, model, effort)
        : inactiveResult("codex"),
  ),
);

// --- Claude tools (only when some OTHER agent is the host) -----------------

memberTools.claude.push(
  server.registerTool(
    "ask_claude",
    {
      description:
        "Ask Claude (Anthropic) directly for an independent second opinion — a strong generalist coder's take. Continue with `claude_reply`. (Available only when the host is not Claude.)",
      inputSchema: {
        question: z.string().describe("The specific question or decision to put to Claude."),
        context: z.string().optional().describe("Optional background, constraints, or relevant snippets."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ question, context, time, model, effort }, extra) =>
      isActive("claude")
        ? ask("claude", askClaudePrompt(hostName(), question, context), extra, "ask_claude", time, model, effort)
        : inactiveResult("claude"),
  ),
);

memberTools.claude.push(
  server.registerTool(
    "claude_reply",
    {
      description:
        "Continue the conversation with Claude on the SAME session (it remembers the thread). Use to push back on or follow up Claude's last answer.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Claude."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ message, time, model, effort }, extra) =>
      isActive("claude")
        ? ask("claude", replyPrompt(hostName(), message), extra, "claude_reply", time, model, effort)
        : inactiveResult("claude"),
  ),
);

// --- Copilot tools --------------------------------------------------------

memberTools.copilot.push(
  server.registerTool(
    "ask_copilot",
    {
      description:
        "Ask GitHub Copilot directly for an independent second opinion. Continue with `copilot_reply`.",
      inputSchema: {
        question: z.string().describe("The specific question or task to put to Copilot."),
        context: z.string().optional().describe("Optional background, constraints, or relevant snippets."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ question, context, time, model, effort }, extra) =>
      isActive("copilot")
        ? ask("copilot", askCopilotPrompt(hostName(), question, context), extra, "ask_copilot", time, model, effort)
        : inactiveResult("copilot"),
  ),
);

memberTools.copilot.push(
  server.registerTool(
    "copilot_reply",
    {
      description:
        "Continue the conversation with Copilot on the SAME session (it remembers the thread). Use to push back on or follow up Copilot's last answer.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Copilot."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ message, time, model, effort }, extra) =>
      isActive("copilot")
        ? ask("copilot", replyPrompt(hostName(), message), extra, "copilot_reply", time, model, effort)
        : inactiveResult("copilot"),
  ),
);

// --- Grok tools -----------------------------------------------------------

memberTools.grok.push(
  server.registerTool(
    "ask_grok",
    {
      description:
        "Ask Grok (xAI) directly for a second opinion with live web/X search and current-events knowledge. Continue with `grok_reply`; for generated media use `grok_generate`.",
      inputSchema: {
        question: z.string().describe("The specific question or task to put to Grok."),
        context: z.string().optional().describe("Optional background, constraints, or relevant snippets."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ question, context, time, model, effort }, extra) =>
      isActive("grok")
        ? ask("grok", askGrokPrompt(hostName(), question, context), extra, "ask_grok", time, model, effort)
        : inactiveResult("grok"),
  ),
  server.registerTool(
    "grok_reply",
    {
      description:
        "Continue the conversation with Grok on the SAME session (it remembers the thread). Use to push back on or follow up Grok's last answer.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Grok."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ message, time, model, effort }, extra) =>
      isActive("grok")
        ? ask("grok", replyPrompt(hostName(), message), extra, "grok_reply", time, model, effort)
        : inactiveResult("grok"),
  ),
  server.registerTool(
    "grok_generate",
    {
      description:
        "Generate an image or short video with Grok and save it into the workspace. Grok may ask for permission to write the output file.",
      inputSchema: {
        prompt: z.string().describe("What to generate."),
        kind: z.enum(["image", "video"]).optional().describe("Media type. Defaults to image."),
        output_path: z.string().optional().describe("Optional workspace-relative output path."),
        ...modelField,
        ...effortField,
        ...timeField,
      },
    },
    ({ prompt, kind, output_path, time, model, effort }, extra) =>
      isActive("grok")
        ? ask("grok", grokGeneratePrompt(prompt, kind ?? "image", output_path), extra, "grok_generate", time, model, effort)
        : inactiveResult("grok"),
  ),
);

// --- Delegate tools (members as managed coders; ADR 0018) -------------------
// Each named delegate runs on its OWN session, separate from the member's advisor
// session, so several delegates can work concurrently (the host issues parallel
// tool calls) and coding context never bleeds into the advisor debates.
// Permissions follow the member's native ACP mode — the delegate sessions are not
// pinned like advisors.

interface Delegate {
  member: MemberId;
  alias: string;
  session: AcpSession;
}
/** Live delegates, keyed `${member}:${alias}`. Disposed and cleared by `reset`. */
const delegates = new Map<string, Delegate>();
const MAX_DELEGATES = 8;
const DELEGATE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** How the host addresses a delegate's pending permission in `permit`. */
const permitRef = (d: Delegate): string => `member \`${d.member}\`, delegate \`${d.alias}\``;

// Delegates don't survive the host's /clear: mirror AcpSession's per-session
// epoch check at the map level — a changed reset nonce dismisses every delegate,
// so an alias from the previous conversation can't collide with (and receive
// steering framing meant for) a fresh one.
let delegateNonce = readResetNonce();
function readResetNonce(): string | undefined {
  try {
    return readFileSync(resetNonceFile(config.workspaceRoot), "utf8") || undefined;
  } catch {
    return undefined; // missing/unreadable is "no change"
  }
}
function checkDelegateEpoch(): void {
  const nonce = readResetNonce();
  if (nonce !== undefined && nonce !== delegateNonce) {
    delegateNonce = nonce;
    for (const d of delegates.values()) d.session.dispose();
    delegates.clear();
  }
}

interface DelegateArgs {
  task: string;
  context?: string;
  name?: string;
  mode?: string;
  model?: string;
  effort?: string;
  time?: number;
}

function runDelegate(id: MemberId, args: DelegateArgs, extra: Extra): Promise<ToolResult> | ToolResult {
  if (!isActive(id)) return inactiveResult(id);
  checkDelegateEpoch();
  const alias = (args.name ?? id).trim();
  if (!DELEGATE_NAME.test(alias)) {
    return textResult(`Invalid delegate name "${alias}" — use a short lowercase slug (${DELEGATE_NAME}).`);
  }
  const key = `${id}:${alias}`;
  let d = delegates.get(key);
  // Never let a new task land on a delegate mid-turn: a queued ask() would trigger
  // the gateWaiters abandon path if the turn suspends (fine for advisors,
  // destructive for a coder), so refuse instead of queueing.
  if (d?.session.isAwaitingPermission()) {
    return textResult(
      `Delegate ${key} is paused awaiting your permission decision — resolve it first with **permit** ` +
        `(${permitRef(d)}); sending a new task now would abandon its half-done turn.`,
    );
  }
  if (d?.session.isBusy()) {
    return textResult(
      `Delegate ${key} is still working on its previous task — wait for that call to finish (or cancel it) before steering; queueing a new task now could abandon its in-flight turn.`,
    );
  }
  if (!d) {
    if (delegates.size >= MAX_DELEGATES) {
      return textResult(
        `Delegate limit reached (${MAX_DELEGATES} live: ${[...delegates.keys()].join(", ")}) — \`reset\` clears them all.`,
      );
    }
    // The spec clone gives the delegate a distinct display name in output/logs.
    d = { member: id, alias, session: new AcpSession(config, { ...specs[id], name: `${specs[id].name}[${alias}]` }) };
    delegates.set(key, d);
  }
  const del = d;
  // A session that hasn't started (new delegate, or dropped by reset/startup
  // failure) gets the full delegate framing; a live one gets a steering follow-up
  // on its accumulated context.
  const firstTurn = !del.session.status().sessionStarted;
  const prompt = firstTurn
    ? delegatePrompt(specs[id].promptName, hostName(), args.task, args.context)
    : delegateSteerPrompt(hostName(), args.task, args.context);
  const session = del.session;
  return session
    .ask(prompt, {
      label: `delegate_${id}`,
      signal: extra.signal,
      timeoutMs: args.time !== undefined ? args.time * 1000 : undefined,
      mode: args.mode,
      model: args.model,
      effort: args.effort,
      ...streamHooks(progressNotifier(extra)),
    })
    .then((outcome) => renderOutcome(outcome, session.name, permitRef(del)))
    .catch((err: unknown) => renderMemberError(session.name, err, session.loginHint));
}

const delegateInput = {
  task: z
    .string()
    .describe(
      "The implementation task to delegate: goal, scope, and which files/areas this delegate owns (partition the tree when running several delegates). On a follow-up call (same `name`), this is your steering message.",
    ),
  context: z.string().optional().describe("Optional background: constraints, relevant paths, prior decisions."),
  name: z
    .string()
    .optional()
    .describe(
      "Delegate instance id (short lowercase slug). Re-use the same name to steer that delegate's live session; use different names for parallel delegates. Defaults to the member id.",
    ),
  ...modeField,
  ...modelField,
  ...effortField,
  ...timeField,
};

memberTools.codex.push(
  server.registerTool(
    "delegate_codex",
    {
      description:
        "Hand Codex an implementation task as your delegate coder: it edits files and runs commands in this workspace on its own named session, then reports back (outcome, files changed, verification, blockers). Run several delegates concurrently by issuing parallel tool calls with different `name`s; re-call with the same `name` to steer or follow up. Permissions follow Codex's native ACP mode (default `agent` — sandboxed writes/commands with its internal Guardian review; set `mode` to change, see available_councilors); anything it still escalates (network, outside-workspace paths) pauses 🔐 for your judgement via `permit` — you stay the guardian for risky actions.",
      inputSchema: delegateInput,
    },
    (args, extra) => runDelegate("codex", args, extra),
  ),
);

memberTools.claude.push(
  server.registerTool(
    "delegate_claude",
    {
      description:
        "Hand Claude (Anthropic) an implementation task as your delegate coder: it edits files and runs commands in this workspace on its own named session, then reports back (outcome, files changed, verification, blockers). Run several delegates concurrently with different `name`s; re-call with the same `name` to steer. Permissions follow Claude's native ACP mode (default `auto` — a classifier judges permission prompts; `acceptEdits`/`bypassPermissions` loosen, `default` routes everything risky to you); whatever it still surfaces pauses 🔐 for your judgement via `permit` — you stay the guardian for risky actions.",
      inputSchema: delegateInput,
    },
    (args, extra) => runDelegate("claude", args, extra),
  ),
);

memberTools.copilot.push(
  server.registerTool(
    "delegate_copilot",
    {
      description:
        "Hand GitHub Copilot an implementation task as your delegate coder on its own named session; it reports back when done. Run several delegates concurrently with different `name`s; re-call with the same `name` to steer. Permissions follow Copilot CLI's native ACP behavior; whatever it escalates pauses 🔐 for your judgement via `permit` — review its diff like any delegate's.",
      inputSchema: delegateInput,
    },
    (args, extra) => runDelegate("copilot", args, extra),
  ),
);

memberTools.grok.push(
  server.registerTool(
    "delegate_grok",
    {
      description:
        "Hand Grok an implementation task as your delegate coder on its own named session. Grok has been observed writing workspace files without surfacing a request — partition its work and review its diff.",
      inputSchema: delegateInput,
    },
    (args, extra) => runDelegate("grok", args, extra),
  ),
);

// --- Deliberative tools (one advisor; default Codex) ----------------------
// Structured single-advisor passes. They take an optional `member` (default
// Codex, or the first active advisor if Codex is the host), so they work against
// any council member — always registered, not tied to one member's host status.

const memberField = {
  member: z
    .enum([...MEMBER_IDS, "council"] as unknown as [MemberId | "council", ...(MemberId | "council")[]])
    .optional()
    .describe(
      'Which advisor to ask: a specific roster member, or "council" to fan out to all active advisors. Defaults to Codex (or the first available advisor if Codex is the host).',
    ),
};

server.registerTool(
  "review_plan",
  {
    description:
      "Have an advisor critique a plan or approach BEFORE you implement it — verdict, problems by severity, blind spots, and what to keep. Defaults to Codex; continue with that advisor's reply tool.",
    inputSchema: {
      plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
      context: z.string().optional().describe("Optional background or constraints."),
      ...memberField,
      ...modelField,
      ...effortField,
      ...modelsField,
      ...effortsField,
      ...timeField,
    },
  },
  ({ plan, context, member, time, model, effort, models, efforts }, extra) => {
    const build = (id: MemberId): string => reviewPlanPrompt(specs[id].promptName, hostName(), plan, context);
    if (member === "council")
      return councilFanOut(
        "review_plan",
        build,
        extra,
        time !== undefined ? time * 1000 : undefined,
        persistentSession,
        activeIds(),
        undefined,
        models,
        efforts,
      );
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "review_plan", time, model, effort);
  },
);

server.registerTool(
  "review_diff",
  {
    description:
      "Have an advisor review code changes for correctness bugs and gaps. Pass a diff, or name paths and let the advisor read the working tree (it may ask permission to run `git diff`). Defaults to Codex.",
    inputSchema: {
      diff: z.string().optional().describe("A unified diff to review. Omit to let the advisor inspect `git diff` itself."),
      paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
      instructions: z.string().optional().describe("Optional extra focus for the review."),
      ...memberField,
      ...modelField,
      ...effortField,
      ...modelsField,
      ...effortsField,
      ...timeField,
    },
  },
  ({ diff, paths, instructions, member, time, model, effort, models, efforts }, extra) => {
    const build = (id: MemberId): string => reviewDiffPrompt(specs[id].promptName, hostName(), { diff, paths, instructions });
    if (member === "council") {
      // Council mode is read-only — it can't run `git diff`. Without an explicit
      // diff the advisors would have nothing to review, so refuse early rather
      // than fan out to a guaranteed "I couldn't inspect the changes".
      if (!diff || diff.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: 'review_diff with `member: "council"` needs an explicit `diff`: council mode is read-only and can\'t run `git diff`. Pass a diff, or use single-advisor review_diff (default Codex), which can run `git diff` via a permit.',
            },
          ],
        };
      }
      return councilFanOut(
        "review_diff",
        build,
        extra,
        time !== undefined ? time * 1000 : undefined,
        persistentSession,
        activeIds(),
        undefined,
        models,
        efforts,
      );
    }
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "review_diff", time, model, effort);
  },
);

server.registerTool(
  "brainstorm",
  {
    description:
      "Co-design with an advisor: get 2–4 alternative approaches with trade-offs and a recommendation, to compare against your own. Defaults to Codex.",
    inputSchema: {
      problem: z.string().describe("The design problem to explore."),
      constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
      ...memberField,
      ...modelField,
      ...effortField,
      ...modelsField,
      ...effortsField,
      ...timeField,
    },
  },
  ({ problem, constraints, member, time, model, effort, models, efforts }, extra) => {
    const build = (id: MemberId): string => brainstormPrompt(specs[id].promptName, hostName(), problem, constraints);
    if (member === "council")
      return councilFanOut("brainstorm", build, extra, time !== undefined ? time * 1000 : undefined, persistentSession, activeIds(), undefined, models, efforts);
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "brainstorm", time, model, effort);
  },
);

server.registerTool(
  "explore",
  {
    description:
      "Have an advisor explore an unfamiliar codebase and report its structure, key components, data/control flow, and conventions. Good for initial orientation. Defaults to Codex.",
    inputSchema: {
      focus: z.string().optional().describe("What to focus the exploration on (a feature, subsystem, or question)."),
      paths: z.string().optional().describe("Optional starting paths."),
      ...memberField,
      ...modelField,
      ...effortField,
      ...modelsField,
      ...effortsField,
      ...timeField,
    },
  },
  ({ focus, paths, member, time, model, effort, models, efforts }, extra) => {
    const build = (id: MemberId): string => explorePrompt(specs[id].promptName, hostName(), focus, paths);
    if (member === "council")
      return councilFanOut("explore", build, extra, time !== undefined ? time * 1000 : undefined, persistentSession, activeIds(), undefined, models, efforts);
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "explore", time, model, effort);
  },
);

// --- The Magi council -----------------------------------------------------

server.registerTool(
  "consult",
  {
    description:
      `Run one stage of independent council refinement: draft, critique, then revise. Finish your own draft, critique, and revision before the first call, so advisor drafts cannot influence your independent candidate. Keep that candidate separate until aggregation. Each advisor gets a fresh session with the shared question and only its own previous artifacts. Use neutral context; do not share host or peer positions before refinement ends. After draft, call critique with each advisor's candidate in previous. Then call revise with that candidate and its critique. Aggregate the revised candidates with your own, using evidence and task checks. Repeat critique/revise only within a chosen budget. Agreement alone is not a stopping rule. The host is excluded from the advisor roster. For targeted reviews use ${askToolNames} or review_plan/review_diff.`,
    inputSchema: {
      question: z.string().describe("The question or decision to put to the council."),
      context: z.string().optional().describe("Shared task facts and constraints. Keep host and peer proposals out of this context."),
      phase: z.enum(["draft", "critique", "revise"]).default("draft").describe("One stage per call. Default: independent drafts. Follow with critique, then revise."),
      previous: z
        .record(memberSchema, z.object({
          candidate: z.string().trim().min(1),
          critique: z.string().trim().min(1).optional(),
        }))
        .optional()
        .describe("Previous artifacts keyed by advisor id. Critique requires each selected advisor's candidate. Revise also requires its critique. Each advisor receives only its own entry. Omit for draft."),
      members: z
        .array(memberSchema)
        .optional()
        .describe(
          "Which roster members sit on the council for this call. Omit for every active advisor; the host is never a member.",
        ),
      ...modelsField,
      ...effortsField,
      ...timeField,
    },
  },
  (args, extra) => runMagi(args, extra),
);

interface MagiArgs {
  question: string;
  context?: string;
  phase?: CouncilPhase;
  previous?: Partial<Record<MemberId, CouncilCandidate>>;
  members?: MemberId[];
  models?: ModelSelection;
  efforts?: EffortSelection;
  time?: number;
}

/** Render one council voice (answer + any blocked actions + footer). */
function renderVoice(name: string, result: AskResult | null): string {
  const complete = result?.stopReason === "end_turn" && result.text.trim().length > 0;
  const body = complete ? result.text : `_Incomplete advisor output (${result?.stopReason ?? "no result"}${result && !result.text.trim() ? "; empty response" : ""}). Do not use it as a candidate or critique in another stage._`;
  const lines = [`### ${name}`, "", body];
  const blocked = (result?.log ?? [])
    .filter((l) => l.startsWith("auto-denied:"))
    .map((l) => l.replace(/^auto-denied:\s*/, ""));
  if (blocked.length > 0) lines.push("", `⚠️ blocked in council mode: ${blocked.join("; ")}`);
  if (result) lines.push("", footer(result));
  return lines.join("\n");
}

/** Resolve a persistent advisor session or an isolated consult session. */
type SessionFor = (id: MemberId) => AcpSession;
const persistentSession: SessionFor = (id) => sessions[id];

/**
 * Run one advisor's council turn (read-only, atomic — guardian "ask" auto-denies,
 * so it never suspends), returning both its rendered voice and its raw answer text
 * (for the settlement check). Member errors are caught and rendered, so one failing
 * advisor never sinks the others.
 */
async function councilTurn(
  id: MemberId,
  prompt: string,
  label: string,
  prefix: string,
  extra: Extra,
  notify: Notify,
  timeoutMs: number | undefined,
  model: string | undefined,
  effort: string | undefined,
  getSession: SessionFor,
): Promise<{ name: string; markup: string; text: string }> {
  const name = specs[id].name;
  try {
    const outcome = await getSession(id).ask(prompt, {
      label,
      signal: extra.signal,
      timeoutMs,
      model,
      effort,
      onAskPermission: "read-only",
      ...streamHooks(notify, prefix),
    });
    const result = outcome.type === "answer" ? outcome.result : null;
    return { name, markup: renderVoice(name, result), text: result?.stopReason === "end_turn" ? result.text : "" };
  } catch (err) {
    return {
      name,
      markup: `### ${name}\n\n${renderMemberError(name, err, specs[id].loginHint).content[0]!.text}`,
      text: "",
    };
  }
}

/** Prepended when the host is unrecognized (one voice may be the host itself). */
function unknownHostWarning(): string | undefined {
  const r = resolveHost();
  return r.source === "unknown"
    ? `⚠️ Host not recognized (clientInfo: ${r.rawClient ?? "none"}); all roster members are participating, so one of these voices may be you. Set \`MAGI_COUNCIL_EXCLUDE=claude|codex|copilot|grok\` to exclude yourself.`
    : undefined;
}

/**
 * Fan a task out to every active advisor and render their voices for the host to
 * synthesize. `buildPrompt(id)` produces each advisor's prompt. Advisors run
 * **concurrently** (each on its own session/gate) and are rendered in member
 * order; the whole council is still one atomic tool call. Each member is caught
 * independently so one failure still returns the others. (Advisors answer
 * independently; they do not see each other's replies.)
 */
async function councilFanOut(
  label: string,
  buildPrompt: (id: MemberId) => string,
  extra: Extra,
  timeoutMs: number | undefined,
  getSession: SessionFor = persistentSession,
  ids: MemberId[] = activeIds(),
  synth?: string,
  models?: ModelSelection,
  efforts?: EffortSelection,
): Promise<ToolResult> {
  const host = hostName();
  const sections: string[] = [];
  const warning = unknownHostWarning();
  if (warning) sections.push(warning);

  const notify = progressNotifier(extra); // one shared channel for all concurrent advisors
  const voices = await Promise.all(
    ids.map((id) =>
      councilTurn(
        id,
        buildPrompt(id),
        label,
        `${specs[id].name} `,
        extra,
        notify,
        timeoutMs,
        models?.[id],
        efforts?.[id],
        getSession,
      ),
    ),
  );
  sections.push(...voices.map((v) => v.markup));

  const footer =
    synth ??
    `_You (${host}) are the lead — weigh these voices and decide. Follow up with ${replyToolNames}, or ask one directly with ${askToolNames}._`;
  return { content: [{ type: "text", text: [...sections, footer].join("\n\n---\n\n") }] };
}

/** Run one isolated refinement stage. The host carries each advisor's artifacts. */
async function runMagi(args: MagiArgs, extra: Extra): Promise<ToolResult> {
  const { question, context, previous, time } = args;
  const phase = args.phase ?? "draft";
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  const host = hostName();

  const disabled = args.members?.find((id) => !isEnabled(id));
  if (disabled) return inactiveResult(disabled);

  // Who's on the council this call: the default active advisors, or an explicit
  // subset of them. The host is never a member — it participates by *driving* the
  // rounds (see the closing instruction), not by being spawned.
  const active = selectCouncil(args.members, activeIds());
  if (active.length === 0) {
    return { content: [{ type: "text", text: "No active council members in your selection." }] };
  }

  if (phase === "draft" && previous && Object.keys(previous).length > 0) {
    return { isError: true, content: [{ type: "text", text: "Draft starts independently. Omit previous artifacts." }] };
  }
  if (phase !== "draft") {
    const missing = active.filter((id) => !previous?.[id]?.candidate.trim() || (phase === "revise" && !previous[id]?.critique?.trim()));
    if (missing.length > 0) {
      return { isError: true, content: [{ type: "text", text: `${phase} requires ${phase === "revise" ? "a candidate and critique" : "a candidate"} in previous for: ${missing.join(", ")}. No advisors were called.` }] };
    }
  }

  const next: Record<CouncilPhase, string> = {
    draft: "Keep your independently refined candidate separate from these drafts. Call consult with phase=critique and each advisor's draft in previous[id].candidate. Keep the same question, neutral context, members, models, and efforts. Do not aggregate yet.",
    critique: "Keep your independently refined candidate unchanged. Call consult with phase=revise, preserving each advisor's candidate and adding only that advisor's critique to its previous entry. Do not aggregate yet.",
    revise: "Aggregate these revised candidates with your own revised candidate. Prefer repository evidence, tests, and counterexamples. Use plurality only for comparable normalized answers; resolve ties with evidence and report unresolved differences. Further depth means another critique/revise pair on each advisor's latest candidate, within your chosen budget. Agreement alone is not proof of correctness.",
  };
  const ephemeral: Partial<Record<MemberId, AcpSession>> = {};
  const getSession: SessionFor = (id) => (ephemeral[id] ??= advisorSession(id));

  try {
    return await councilFanOut(
      `consult:${phase}`,
      (id) =>
        magiAdvisorPrompt({
          advisor: specs[id].promptName,
          host,
          question,
          context,
          phase,
          previous: previous?.[id],
          fellowAdvisors: active.filter((x) => x !== id).map((x) => specs[x].name),
          grokStrengths: id === "grok",
        }),
      extra,
      timeoutMs,
      getSession,
      active,
      `_You (${host}) are the lead and a participant. Carry only complete artifacts to the next stage. If none remain, stop and report the failures. ${next[phase]}_`,
      args.models,
      args.efforts,
    );
  } finally {
    for (const s of Object.values(ephemeral)) s?.dispose();
  }
}

// --- Shared session controls ----------------------------------------------

function renderSelector(category: SelectorCategory, inv: SelectorInventory): string[] {
  const label = selectorLabel(category);
  const plural = selectorPluralLabel(category);
  const lines = [
    `  ${label} selector: ${inv.selector ? `${inv.selector.name} (${inv.selector.id})` : "not reported"}`,
    `  current ${label}: ${inv.current ?? "not reported"}`,
  ];
  if (inv.choices.length === 0) {
    lines.push(`  ${plural}: not reported by ACP`);
  } else {
    lines.push(`  ${plural}:`);
    for (const choice of inv.choices) {
      const name = choice.name === choice.value ? choice.value : `${choice.value} (${choice.name})`;
      const group = choice.group ? ` [${choice.group}]` : "";
      lines.push(`    ${name}${group}${choice.current ? " (current)" : ""}`);
    }
  }
  return lines;
}

function renderInventory(id: MemberId, inventory: MemberInventory): string {
  return [
    `${specs[id].name}:`,
    `  session: ${inventory.sessionStarted ? "started" : "not started"}`,
    ...renderSelector("model", inventory.model),
    ...renderSelector("mode", inventory.mode),
    ...renderSelector("thought_level", inventory.thoughtLevel),
  ].join("\n");
}

server.registerTool(
  "available_councilors",
  {
    description:
      "List all members, including members outside the council roster. Start requested active advisors if needed and report the ACP model, permission-mode, and reasoning-effort selectors they expose. Does not send a prompt turn.",
    inputSchema: {
      members: z
        .array(memberSchema)
        .optional()
        .describe("Optional members to inspect. Omit for every active advisor plus members outside the roster."),
    },
  },
  async ({ members }, extra) => {
    const disabled = MEMBER_IDS.filter((id) => !isEnabled(id) && (!members || members.includes(id)));
    const ids = selectCouncil(members, activeIds());
    const sections = await Promise.all(
      ids.map(async (id) => {
        try {
          return renderInventory(id, await sessions[id].availableSelectors(extra.signal));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `${specs[id].name}:\n  unavailable: ${msg}`;
        }
      }),
    );
    sections.push(
      ...disabled.map(
        (id) => `${specs[id].name}:\n  outside council roster: add ${id} to MAGI_COUNCIL_MEMBERS and restart to enable`,
      ),
    );
    if (sections.length === 0) {
      return { content: [{ type: "text" as const, text: "No active advisors in your selection." }] };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `${sections.join("\n\n")}\n\nUse the value at the start of a choice row, not the display name, when possible.`,
        },
      ],
    };
  },
);

server.registerTool(
  "permit",
  {
    description:
      "Resolve a permission a member or delegate raised mid-turn (when a tool just returned a 🔐 permission). Judge whether the action is reasonable, then allow or deny; the suspended turn resumes and runs to its next pause or its answer. Pass `member` (and `delegate` for a delegate_X session) if more than one is paused at once. Only valid right after a tool returned a permission request.",
    inputSchema: {
      decision: z.enum(["allow", "deny"]).describe("Whether to let the member perform the requested action."),
      member: z
        .enum(MEMBER_IDS as [MemberId, ...MemberId[]])
        .optional()
        .describe("Which member to resolve. Optional when only one session is paused; required if more than one is."),
      delegate: z
        .string()
        .optional()
        .describe("Delegate name to resolve, for a permission raised by a delegate_X tool (combine with `member`)."),
      note: z.string().optional().describe("Optional short reason for the decision (recorded in the debug log)."),
      ...timeField,
    },
  },
  ({ decision, member, delegate, note, time }, extra) => {
    // Candidates: advisor sessions (unless a delegate was named) plus delegates,
    // narrowed by `member`/`delegate`, then filtered to those actually paused.
    const pending = [
      ...(delegate
        ? []
        : activeIds()
            .filter((id) => !member || id === member)
            .map((id) => ({ key: id as string, session: sessions[id], ref: undefined as string | undefined }))),
      ...[...delegates.values()]
        .filter((d) => (!member || d.member === member) && (!delegate || d.alias === delegate))
        .map((d) => ({ key: `${d.member}:${d.alias}`, session: d.session, ref: permitRef(d) })),
    ].filter((c) => c.session.isAwaitingPermission());
    if (pending.length === 0) {
      const who = [member, delegate && `delegate ${delegate}`].filter(Boolean).join(" ") || "any member or delegate";
      return textResult(
        `No pending permission to resolve for ${who} — it may have already completed or been superseded by a newer request.`,
      );
    }
    if (pending.length > 1) {
      return textResult(
        `More than one session is paused awaiting a decision (${pending.map((c) => c.key).join(", ")}) — call **permit** again with \`member\` (and \`delegate\` for a delegate) set to one of them.`,
      );
    }
    // Keep the matched candidate's permit address: a resumed delegate turn can
    // raise a SECOND permission, and its 🔐 must be addressed the same way.
    const { session: target, ref } = pending[0]!;
    return target
      .permit(
        decision === "allow",
        {
          label: "permit",
          signal: extra.signal,
          timeoutMs: time !== undefined ? time * 1000 : undefined,
          ...streamHooks(progressNotifier(extra)),
        },
        note,
      )
      .then((outcome) => renderOutcome(outcome, target.name, ref))
      .catch((err: unknown): ToolResult => {
        if (err instanceof NoPendingPermission) {
          return {
            content: [
              {
                type: "text",
                text: "No pending permission to resolve — it may have already completed or been superseded by a newer request.",
              },
            ],
          };
        }
        return renderMemberError(target.name, err, target.loginHint);
      });
  },
);

server.registerTool(
  "reset",
  {
    description:
      "Drop the accumulated session context for ALL members, dismiss all delegates, and start fresh. Use when switching to an unrelated task, when a member seems confused or its context has grown stale, or to clear a turn wedged awaiting a permit (this clears any pending permits). The next call to each member spins up a brand-new session. (When the host is Claude Code, this also happens automatically on /clear if the SessionStart hook is installed — see the README.)",
    inputSchema: {},
  },
  () => {
    for (const id of MEMBER_IDS) sessions[id].reset();
    for (const d of delegates.values()) d.session.dispose();
    delegates.clear();
    return textResult(
      "All member sessions reset and delegates dismissed — the next call to each member starts a fresh session with no prior context.",
    );
  },
);

server.registerTool(
  "status",
  {
    description:
      "Report magi-council's health: the resolved host, council roster, active advisors, workspace, guardian flags, and session health. Read-only; does not start a session.",
    inputSchema: {},
  },
  () => {
    const r = resolveHost();
    const client = r.rawClient ? `clientInfo="${r.rawClient}"` : "clientInfo=none";
    const hostLine = r.excluded
      ? `host: ${specs[r.excluded].name} (excluded; source=${r.source}, ${client})`
      : `host: unknown — all roster members active (source=unknown, ${client}); set MAGI_COUNCIL_EXCLUDE to exclude the host`;
    const lines = [
      `workspace: ${config.workspaceRoot}`,
      hostLine,
      `roster: ${memberIds.map((i) => specs[i].name).join(", ")}`,
      `council: ${activeIds().map((i) => specs[i].name).join(", ")}`,
      "",
      ...activeIds().map((id) => renderStatus(sessions[id].status())),
      ...MEMBER_IDS.filter((id) => !isEnabled(id)).flatMap((id) => [
        "",
        `${specs[id].name}:`,
        `  outside council roster: add ${id} to MAGI_COUNCIL_MEMBERS and restart to enable`,
      ]),
      ...(delegates.size > 0
        ? ["", `delegates (${delegates.size}/${MAX_DELEGATES}):`, ...[...delegates.values()].map((d) => renderStatus(d.session.status()))]
        : []),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

function renderStatus(s: SessionStatus): string {
  const onoff = (b: boolean) => (b ? "on" : "off");
  return [
    `${s.name}:`,
    `  acp command: ${s.acpCommand}`,
    `  guardian: external-reads ${onoff(s.guardian.externalReads)} · writes ${onoff(s.guardian.writes)} · commands ${onoff(s.guardian.commands)}`,
    `  session: ${s.sessionStarted ? "started" : "not started"} · subprocess: ${s.childAlive ? "alive" : "down"}`,
    `  model: ${s.currentModel ?? "not reported"} · mode: ${s.currentMode ?? "not reported"} · reasoning effort: ${s.currentThoughtLevel ?? "not reported"}`,
    ...(s.modePinWarning ? [`  ⚠️ ${s.modePinWarning}`] : []),
    `  ${s.pendingPermission ? `awaiting permit: ${s.pendingPermission}` : "no pending permission"}`,
    s.stderrTail ? `  recent stderr:\n${s.stderrTail}` : "  no stderr captured",
  ].join("\n");
}

// Once the client identifies itself, remove tools for the host and members outside
// the council roster. Call-time guards still protect clients with a stale tool list.
server.server.oninitialized = (): void => {
  const r = resolveHost();
  for (const id of MEMBER_IDS) {
    if (!isEnabled(id) || r.excluded === id) for (const t of memberTools[id]) t.remove();
  }
  const hostLabel = r.excluded ? specs[r.excluded].name : "unknown (all active)";
  process.stderr.write(
    `[magi-council] host=${hostLabel} (source=${r.source}${r.rawClient ? `, client=${r.rawClient}` : ""}); roster=${memberIds
      .map((i) => specs[i].name)
      .join("+")}; council=${activeIds()
      .map((i) => specs[i].name)
      .join("+")}\n`,
  );
};

const transport = new StdioServerTransport();
await server.connect(transport);

function disposeAll(): void {
  for (const id of MEMBER_IDS) sessions[id].dispose();
  for (const d of delegates.values()) d.session.dispose();
}
process.on("SIGINT", () => {
  disposeAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  disposeAll();
  process.exit(0);
});
