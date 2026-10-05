export interface ExperimentCase {
  id: string;
  prompt: string;
  exportName: string;
  checks: Array<{ name: string; input: unknown[]; expected: unknown }>;
}

export const cases: ExperimentCase[] = [
  {
    id: "selector-resolution",
    exportName: "resolveSelector",
    prompt: `Repair resolveSelector for a council client that selects a model, permission mode, or reasoning effort. Return one self-contained TypeScript source file with the exported synchronous function and any local types or helpers. Do not use imports, dependencies, filesystem access, network access, or code evaluation. Do not return prose or Markdown fences.

Signature:
resolveSelector(options: ConfigOption[], category: "model" | "mode" | "thought_level", request: string): Resolution

Input types:
type Choice = { value: string; name: string };
type Group = { group: string; name: string; options: Choice[] };
type ConfigOption = { id: string; name: string; type: string; category?: string | null; currentValue: string; options: (Choice | Group)[] };
type Resolution = { status: "missing-selector" | "no-request" | "unknown-choice" | "ambiguous" | "unchanged" | "change"; selectorId: string | null; value: string | null };

All inputs conform to these types. An option with type other than exactly "select" is ineligible. First choose the first eligible option whose category exactly equals the requested category. Only when none exists, consider eligible options with category absent, null, or empty. For this fallback, split the combined id and name into lowercase ASCII alphanumeric tokens. The model category requires the whole token "model". The mode category requires the whole token "mode" or both whole tokens "permission" and "policy". The thought_level category requires both "thought" and "level", or both "reasoning" and "effort". Tokens may occur in either order. Choose the first fallback match. Do not match substrings and do not reuse an option assigned to a different nonempty category.

If there is no selector, return { status: "missing-selector", selectorId: null, value: null }, even for a blank request. Otherwise selectorId is the selected option's id. Trim whitespace from the request only. A blank request returns status "no-request" and value null. Flatten top-level choices and one-level groups in encounter order. Group labels and ids are not choices. Resolve the request using these tiers in order: exact value, exact name, case-insensitive value, case-insensitive name. Use JavaScript toLowerCase for case-insensitive comparisons. Do not trim choice values or names. Stop at the first tier with any matches. Deduplicate matches by their exact value. If that tier contains more than one distinct value, return status "ambiguous" and value null. Do not fall through to a weaker tier. If every tier is empty, return status "unknown-choice" and value null. For one distinct matched value, return it with status "unchanged" if it exactly equals currentValue, otherwise "change". currentValue may be absent from the choices; it is never an implicit choice.

Buggy starting implementation:
export function resolveSelector(options: any[], category: string, request: string) {
  const selector = options.find(option =>
    option.category === category || (option.id + " " + option.name).toLowerCase().includes(category)
  );
  if (!selector) return { status: "missing-selector", selectorId: null, value: null };
  const choice = selector.options.find((item: any) =>
    (item.value ?? "").toLowerCase() === request.toLowerCase() ||
    (item.name ?? "").toLowerCase() === request.toLowerCase()
  );
  return {
    status: choice ? "change" : "unknown-choice",
    selectorId: selector.id,
    value: choice?.value ?? null,
  };
}`,
    checks: [
      {
        name: "grouped choices and trimmed case-insensitive request",
        input: [[{ id: "models", name: "Models", type: "select", category: "model", currentValue: "small", options: [{ value: "small", name: "Small" }, { group: "premium", name: "Premium", options: [{ value: "Opus-9", name: "Opus Nine" }] }] }], "model", "  opus NINE  "],
        expected: { status: "change", selectorId: "models", value: "Opus-9" },
      },
      {
        name: "select type and explicit category take precedence over fallback",
        input: [[{ id: "disabled", name: "Model", type: "text", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }] }, { id: "model", name: "Fallback", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] }, { id: "explicit", name: "Primary", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }] }, { id: "later", name: "Later", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }] }], "model", "a"],
        expected: { status: "unchanged", selectorId: "explicit", value: "a" },
      },
      {
        name: "mode does not match model substring or another assigned category",
        input: [[{ id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] }, { id: "mode", name: "Permission mode", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }] }], "mode", " "],
        expected: { status: "missing-selector", selectorId: null, value: null },
      },
      {
        name: "fallback aliases use unordered whole tokens and first match",
        input: [[{ id: "effortless", name: "Reasoning", type: "select", category: null, currentValue: "low", options: [{ value: "high", name: "High" }] }, { id: "effort-level", name: "REASONING", type: "select", category: "", currentValue: "low", options: [{ value: "high", name: "High" }] }, { id: "thought_level", name: "Thought level", type: "select", currentValue: "low", options: [{ value: "high", name: "High" }] }], "thought_level", "high"],
        expected: { status: "change", selectorId: "effort-level", value: "high" },
      },
      {
        name: "permission policy is a mode fallback alias",
        input: [[{ id: "policy", name: "Permission policy", type: "select", category: null, currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "allow", name: "Allow" }] }], "mode", "allow"],
        expected: { status: "change", selectorId: "policy", value: "allow" },
      },
      {
        name: "exact value outranks earlier exact name",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "other", options: [{ value: "other", name: "chosen" }, { value: "chosen", name: "Different" }] }], "model", "chosen"],
        expected: { status: "change", selectorId: "m", value: "chosen" },
      },
      {
        name: "exact name outranks case-insensitive value",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "a", options: [{ value: "TARGET", name: "Upper" }, { value: "a", name: "target" }] }], "model", "target"],
        expected: { status: "unchanged", selectorId: "m", value: "a" },
      },
      {
        name: "case-insensitive value outranks case-insensitive name",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "Target" }, { value: "TARGET", name: "Other" }] }], "model", "tArGeT"],
        expected: { status: "change", selectorId: "m", value: "TARGET" },
      },
      {
        name: "ambiguous exact names do not fall through to a unique weaker tier",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "fast" }, { group: "g", name: "Group", options: [{ value: "b", name: "fast" }, { value: "FAST", name: "Upper" }] }] }], "model", "fast"],
        expected: { status: "ambiguous", selectorId: "m", value: null },
      },
      {
        name: "duplicate choices with the same value are not ambiguous",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "x", options: [{ value: "x", name: "Fast" }, { group: "g", name: "Group", options: [{ value: "x", name: "Fast" }] }] }], "model", "Fast"],
        expected: { status: "unchanged", selectorId: "m", value: "x" },
      },
      {
        name: "case-insensitive matching keeps differently cased values distinct",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "Alpha", options: [{ value: "Alpha", name: "First" }, { value: "ALPHA", name: "Second" }] }], "model", "alpha"],
        expected: { status: "ambiguous", selectorId: "m", value: null },
      },
      {
        name: "blank request is a no-op after selector resolution",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "retired", options: [] }], "model", " \t\n"],
        expected: { status: "no-request", selectorId: "m", value: null },
      },
      {
        name: "group name is not a selectable choice",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "x", options: [{ group: "premium", name: "Premium", options: [{ value: "x", name: "X" }] }] }], "model", "Premium"],
        expected: { status: "unknown-choice", selectorId: "m", value: null },
      },
      {
        name: "current value is not an implicit choice",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "retired", options: [{ value: "x", name: "X" }] }], "model", "retired"],
        expected: { status: "unknown-choice", selectorId: "m", value: null },
      },
      {
        name: "choice values and labels retain their own whitespace",
        input: [[{ id: "m", name: "M", type: "select", category: "model", currentValue: "x", options: [{ value: " padded ", name: " Padded " }] }], "model", "padded"],
        expected: { status: "unknown-choice", selectorId: "m", value: null },
      },
    ],
  },
  {
    id: "streamed-turn-assembly",
    exportName: "assembleTurn",
    prompt: `Repair assembleTurn for a council client that receives interleaved streaming events. Return one self-contained TypeScript source file with the exported synchronous function and any local types or helpers. Do not use imports, dependencies, filesystem access, network access, or code evaluation. Do not return prose or Markdown fences.

Signature:
assembleTurn(turnId: string, events: Event[]): Turn

Input types:
type Event = { turnId: string; kind: string; [key: string]: unknown };
type Tool = { id: string; title: string; status: "pending" | "running" | "completed" | "failed"; output: string };
type Turn = { text: string; tools: Tool[]; stopReason: string | null };

Events are in arrival order. Every event has a string turnId and kind. Known event kinds have the fields described below with the stated types. Unknown kinds may have other fields. Only events whose turnId exactly equals the argument affect the result. Start with empty text, an empty tools array, and stopReason null. Process relevant events in order. Do not sort by ids or statuses. Text, tool ids, titles, and outputs can contain any strings, including empty strings or names of JavaScript object properties. Preserve their contents exactly.

A "message" event has text: string and optional mode: "append" | "replace". Append its text to the accumulated message by default. In replace mode replace the entire accumulated message, including when the text is empty. A "thought" event has no effect. Every other unknown kind has no effect.

A "tool" event has id: string and optional title: string, status: "pending" | "running" | "completed" | "failed", output: string | null, and outputMode: "append" | "replace". The first event for each tool id creates a tool with title "", status "pending", and output "" before applying the event's fields. Later events for that exact id update the same tool. Output tools in order of first relevant appearance. An omitted title or status preserves its previous value. A supplied empty title clears the title. A supplied status replaces the previous status, even if it goes from a terminal status to a nonterminal status. No status locks a tool. An omitted output preserves the prior output, regardless of outputMode. A null output clears output, regardless of outputMode. For a string output, append by default or replace if outputMode is "replace". An empty string follows the same append/replace rule. Never add event-only fields to returned tools.

A "done" event has stopReason: string. The first relevant done event sets stopReason and ends processing. Ignore all subsequent events, including tool updates, messages, and later done events. A done event for another turn does not stop processing. Without a relevant done event, stopReason stays null. Return exactly the Turn fields and exactly the Tool fields above.

Buggy starting implementation:
export function assembleTurn(turnId: string, events: any[]) {
  let text = "";
  let stopReason = null;
  const tools: Record<string, any> = {};
  for (const event of events) {
    if (event.kind === "message") text += event.text;
    if (event.kind === "tool") {
      tools[event.id] = {
        id: event.id,
        title: event.title || "",
        status: event.status || "pending",
        output: event.output || "",
      };
    }
    if (event.kind === "done") stopReason = event.stopReason;
  }
  return { text, tools: Object.values(tools), stopReason };
}`,
    checks: [
      {
        name: "empty stream preserves initial state",
        input: ["t", []],
        expected: { text: "", tools: [], stopReason: null },
      },
      {
        name: "message append preserves whitespace and empty chunks",
        input: ["t", [{ turnId: "t", kind: "message", text: " A\n" }, { turnId: "t", kind: "message", text: "" }, { turnId: "t", kind: "message", text: "B\t", mode: "append" }]],
        expected: { text: " A\nB\t", tools: [], stopReason: null },
      },
      {
        name: "message replacement can clear accumulated text",
        input: ["t", [{ turnId: "t", kind: "message", text: "draft" }, { turnId: "t", kind: "message", text: "revised", mode: "replace" }, { turnId: "t", kind: "message", text: "", mode: "replace" }, { turnId: "t", kind: "message", text: "final" }]],
        expected: { text: "final", tools: [], stopReason: null },
      },
      {
        name: "another turn cannot append text or terminate this turn",
        input: ["t", [{ turnId: "other", kind: "message", text: "foreign" }, { turnId: "other", kind: "done", stopReason: "cancelled" }, { turnId: "t", kind: "message", text: "ours" }]],
        expected: { text: "ours", tools: [], stopReason: null },
      },
      {
        name: "thoughts and unknown event kinds do not become visible text or tools",
        input: ["t", [{ turnId: "t", kind: "thought", text: "private" }, { turnId: "t", kind: "tool_result", id: "x", output: "ignored" }, { turnId: "t", kind: "message", text: "visible" }, { turnId: "t", kind: "heartbeat" }]],
        expected: { text: "visible", tools: [], stopReason: null },
      },
      {
        name: "first partial tool event uses defaults",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a" }]],
        expected: { text: "", tools: [{ id: "a", title: "", status: "pending", output: "" }], stopReason: null },
      },
      {
        name: "partial updates preserve other fields and append output",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a", title: "Read", status: "running", output: "line 1\n" }, { turnId: "t", kind: "tool", id: "a", output: "line 2" }, { turnId: "t", kind: "tool", id: "a", status: "completed" }]],
        expected: { text: "", tools: [{ id: "a", title: "Read", status: "completed", output: "line 1\nline 2" }], stopReason: null },
      },
      {
        name: "explicit empty title and replacement output clear their fields",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a", title: "Read", status: "running", output: "old" }, { turnId: "t", kind: "tool", id: "a", title: "", output: "", outputMode: "replace" }]],
        expected: { text: "", tools: [{ id: "a", title: "", status: "running", output: "" }], stopReason: null },
      },
      {
        name: "null output clears before later append",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a", output: "old" }, { turnId: "t", kind: "tool", id: "a", output: null, outputMode: "append" }, { turnId: "t", kind: "tool", id: "a", output: "new" }]],
        expected: { text: "", tools: [{ id: "a", title: "", status: "pending", output: "new" }], stopReason: null },
      },
      {
        name: "numeric-looking tool ids retain first appearance order",
        input: ["t", [{ turnId: "t", kind: "tool", id: "10", title: "First", output: "a" }, { turnId: "t", kind: "tool", id: "2", title: "Second", output: "b" }, { turnId: "t", kind: "tool", id: "10", output: "c" }, { turnId: "t", kind: "tool", id: "1", title: "Third" }]],
        expected: { text: "", tools: [{ id: "10", title: "First", status: "pending", output: "ac" }, { id: "2", title: "Second", status: "pending", output: "b" }, { id: "1", title: "Third", status: "pending", output: "" }], stopReason: null },
      },
      {
        name: "first relevant completion freezes all accumulated state",
        input: ["t", [{ turnId: "t", kind: "message", text: "done" }, { turnId: "t", kind: "tool", id: "a", status: "completed", output: "ok" }, { turnId: "t", kind: "done", stopReason: "" }, { turnId: "t", kind: "message", text: "late" }, { turnId: "t", kind: "tool", id: "a", output: "late" }, { turnId: "t", kind: "tool", id: "b" }, { turnId: "t", kind: "done", stopReason: "overwritten" }]],
        expected: { text: "done", tools: [{ id: "a", title: "", status: "completed", output: "ok" }], stopReason: "" },
      },
      {
        name: "foreign tool updates cannot create or overwrite this turn's tools",
        input: ["t", [{ turnId: "other", kind: "tool", id: "b", title: "Foreign" }, { turnId: "t", kind: "tool", id: "a", title: "Ours", output: "ours" }, { turnId: "other", kind: "tool", id: "a", title: "Foreign", output: "foreign", status: "failed" }]],
        expected: { text: "", tools: [{ id: "a", title: "Ours", status: "pending", output: "ours" }], stopReason: null },
      },
      {
        name: "object-property names and empty ids remain independent tool ids",
        input: ["t", [{ turnId: "t", kind: "tool", id: "__proto__", output: "a" }, { turnId: "t", kind: "tool", id: "constructor", output: "b" }, { turnId: "t", kind: "tool", id: "", output: "c" }, { turnId: "t", kind: "tool", id: "__proto__", output: "d" }]],
        expected: { text: "", tools: [{ id: "__proto__", title: "", status: "pending", output: "ad" }, { id: "constructor", title: "", status: "pending", output: "b" }, { id: "", title: "", status: "pending", output: "c" }], stopReason: null },
      },
      {
        name: "output mode alone preserves output and status is allowed to reopen",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a", title: "Run", status: "failed", output: "diagnostic" }, { turnId: "t", kind: "tool", id: "a", status: "running", outputMode: "replace" }, { turnId: "t", kind: "tool", id: "a", output: "", outputMode: "append" }]],
        expected: { text: "", tools: [{ id: "a", title: "Run", status: "running", output: "diagnostic" }], stopReason: null },
      },
      {
        name: "nonempty output replacement and normal completion preserve visible message",
        input: ["t", [{ turnId: "t", kind: "tool", id: "a", title: "Run", output: "draft" }, { turnId: "t", kind: "tool", id: "a", output: "result", outputMode: "replace", status: "completed" }, { turnId: "t", kind: "message", text: "Finished." }, { turnId: "t", kind: "done", stopReason: "end_turn" }]],
        expected: { text: "Finished.", tools: [{ id: "a", title: "Run", status: "completed", output: "result" }], stopReason: "end_turn" },
      },
    ],
  },
];
