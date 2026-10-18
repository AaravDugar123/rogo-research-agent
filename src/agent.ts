/**
 * The research agent: a tool-use loop over the mocked research tools.
 *
 * The model's last turn is the answer. There is no separate editor pass: it cost a
 * full extra model call on the whole transcript and its job ("be brief") worked
 * against what analysts need (figures, periods, caveats).
 */

import Anthropic from "@anthropic-ai/sdk";
import { companies } from "./data.ts";
import { executeTool, toolSchemas } from "./tools.ts";
import { checkPiece, extractNumbers } from "./verify.ts";

const MODEL = process.env.ROGO_MODEL ?? "claude-sonnet-5";
const MAX_ROUNDS = 8;
const MAX_TOKENS = 4000;

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Rogo Research, an assistant that answers questions about companies for financial analysts.

Coverage universe:
${companies
  .map(
    (c) =>
      `- ${c.name} (${c.ticker}) — ${c.sector}, HQ ${c.hq}, ${c.employees} employees. ${c.description}`,
  )
  .join("\n")}

How to research:
- Tools accept company names or tickers. If a name matches more than one company, the tool will tell you.
  If covering each candidate is cheap, cover each and label them clearly. Ask the analyst only if the question
  can't be answered without choosing. Never silently pick one.
- Request independent tool calls in the same turn, e.g. financials for both companies at once.
  For questions about the whole universe, fetch every company in one turn.
- Match effort to the question: a simple fact usually needs one or two calls, so stop once you can answer.
  Use documents when the question is about risks, strategy, or management commentary.
- If a tool returns an error, fix the input as the message suggests. If data isn't available, say what's
  missing. Never fill gaps from memory. Only cover companies in the coverage universe.

How to answer:
- Lead with the direct answer, then the evidence. Keep it as short as the question allows, with no closing recap.
- Make the unit and period clear for every figure, written the way an analyst would: "$2.4 billion in FY2023",
  not "2400 (USD millions)". Calculations are fine; name the inputs, e.g. "up 12% from $2.1 billion to $2.4 billion".
- Cite the source ID in square brackets at the end of each sentence or bullet that uses figures or claims from a
  tool result, including paraphrased document content, e.g. [FIN-XXXX] or [DOC-XXXX-001]. Cite each source once
  per sentence, not after every number. Don't cite your own reasoning or conclusions. Every tool result's title
  starts with its ID.
- Carry over the data's caveats and distinctions: say early if a figure is preliminary, unaudited, unfiled or
  restated, and keep splits the sources draw, such as organic vs acquired growth. If sources disagree, say so.
- For "which is better" questions, compare on specific metrics and state the tradeoffs.
- Plain text. Simple dash bullets are fine. No headings, bold or tables.
`;

const ROUND_LIMIT_NOTE = "Answer now using only what you've gathered. Say what's missing.";

export type AgentEvent =
  | { type: "iteration"; n: number }
  // id tells parallel calls to the same tool apart.
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ms: number }
  | { type: "tool_failed"; id: string; name: string; message: string };

/** A prior turn of the conversation, text only. */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Citation {
  source: string; // e.g. "DOC-ITCH-001" or "FIN-ACMR"
  title: string | null;
  citedText: string;
}

/** A sentence whose numbers could not be confirmed. */
export interface Flag {
  sentence: string;
  numbers: string[];
  sources: string[];
}

/**
 * Hidden: logged and benchmarked, never shown to the analyst. Not acted on yet.
 *
 * Unfinished: the number check reads API citations, which are now off (see tools.ts),
 * so every numeric sentence counts as uncited and confidence sits at 0.5. Next step:
 * check each sentence against the sources its inline [IDs] name. The made-up ID check
 * below already works.
 *
 * confidence scores each number in the answer: verified against the text its sentence
 * cites = 1, uncited = 0.5 (unknown, not wrong), mismatched = 0, then averages.
 * An inline [ID] the agent never fetched is a made-up source, so confidence is 0.
 * null when the answer has no numbers. A heuristic for comparing runs, not a probability.
 */
export interface Verification {
  confidence: number | null;
  checked: number; // numbers checked against the text their sentence cites
  mismatched: Flag[]; // cited, but a number matches nothing in the cited text: a real failure
  uncited: Flag[]; // has numbers but no citation: a soft warning, may be restated context
  unknownSourceIds: string[]; // inline [IDs] that no tool returned in this run
}

export interface AgentResult {
  answer: string;
  iterations: number;
  citations: Citation[];
  verification: Verification;
  truncated: boolean; // the answer hit max_tokens and was cut off
  stats: { toolCalls: number; toolErrors: number; hitRoundLimit: boolean };
}

export async function runAgent(
  question: string,
  onEvent: (event: AgentEvent) => void,
  history: HistoryTurn[] = [],
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: "user", content: question },
  ];
  const stats = { toolCalls: 0, toolErrors: 0, hitRoundLimit: false };
  const fetchedIds = new Set<string>(); // source IDs the tools returned, to spot made-up [IDs]

  async function runTool(use: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const startedAt = Date.now();
    stats.toolCalls++;
    onEvent({ type: "tool_start", id: use.id, name: use.name, input: use.input });
    try {
      // search_result blocks or a plain string, passed through as is so the API can cite them.
      const content = await executeTool(use.name, use.input as Record<string, unknown>);
      // Known IDs: each result's source, plus IDs inside its text (e.g. filing "ITCH-8K-2026-01").
      for (const r of Array.isArray(content) ? content : []) {
        fetchedIds.add(r.source);
        r.content.forEach((c) => inlineIds(`[${c.text.replace(/[^\w-]+/g, " ")}]`).forEach((id) => fetchedIds.add(id)));
      }
      return { type: "tool_result", tool_use_id: use.id, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.toolErrors++;
      onEvent({ type: "tool_failed", id: use.id, name: use.name, message });
      return { type: "tool_result", tool_use_id: use.id, content: message, is_error: true };
    } finally {
      onEvent({ type: "tool_end", id: use.id, name: use.name, ms: Date.now() - startedAt });
    }
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    onEvent({ type: "iteration", n: round });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) return finish(response, round, stats, fetchedIds);

    // Independent tool calls run at once. Promise.all keeps the order, and each
    // result carries its tool_use_id.
    const toolResults = await Promise.all(toolUses.map(runTool));
    messages.push({ role: "user", content: toolResults });
  }

  // Out of rounds: keep the research and ask for an answer from it, with tools off.
  stats.hitRoundLimit = true;
  const lastTurn = messages[messages.length - 1].content as Anthropic.ContentBlockParam[];
  lastTurn.push({ type: "text", text: ROUND_LIMIT_NOTE });
  onEvent({ type: "iteration", n: MAX_ROUNDS + 1 });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: toolSchemas,
    tool_choice: { type: "none" },
    messages,
  });
  return finish(response, MAX_ROUNDS + 1, stats, fetchedIds);
}

/**
 * Builds the result from the final response. With API citations on, the API splits the
 * answer into many text blocks, and a citation can sit on one fragment of a sentence
 * but not the rest. So fragments are merged into sentences, their citations pooled,
 * and each sentence's numbers are checked against the text it cites.
 */
function finish(
  response: Anthropic.Message,
  iterations: number,
  stats: AgentResult["stats"],
  fetchedIds: Set<string>,
): AgentResult {
  const blocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const answer = blocks.map((b) => b.text).join("").trim() || "No answer was produced.";

  const verification: Verification = {
    confidence: null,
    checked: 0,
    mismatched: [],
    uncited: [],
    unknownSourceIds: inlineIds(answer).filter((id) => !fetchedIds.has(id)),
  };
  for (const piece of sentences(blocks)) {
    const numbers = extractNumbers(piece.text);
    if (numbers.length === 0) continue;
    const sentence = piece.text.trim();
    const sources = [...new Set(piece.citations.map((c) => c.source))];
    if (piece.citations.length === 0) {
      verification.uncited.push({ sentence, numbers: numbers.map((n) => n.raw), sources });
      continue;
    }
    verification.checked += numbers.length;
    const wrong = checkPiece(piece.text, piece.citations.map((c) => c.cited_text).join("\n"));
    if (wrong.length) verification.mismatched.push({ sentence, numbers: wrong.map((n) => n.raw), sources });
  }
  verification.confidence = confidence(verification);

  const citations = new Map<string, Citation>();
  for (const c of blocks.flatMap((b) => searchCitations(b))) {
    citations.set(`${c.source}\n${c.cited_text}`, { source: c.source, title: c.title, citedText: c.cited_text });
  }

  return {
    answer,
    iterations,
    citations: [...citations.values()],
    verification,
    truncated: response.stop_reason === "max_tokens",
    stats,
  };
}

/** Verified = 1, uncited = 0.5, mismatched = 0, averaged over every number. See Verification. */
function confidence(v: Verification): number | null {
  if (v.unknownSourceIds.length) return 0;
  const mismatched = v.mismatched.reduce((s, f) => s + f.numbers.length, 0);
  const uncited = v.uncited.reduce((s, f) => s + f.numbers.length, 0);
  const total = v.checked + uncited;
  if (total === 0) return null;
  return Math.round(((v.checked - mismatched + 0.5 * uncited) / total) * 100) / 100;
}

/** IDs cited inline, e.g. "[DOC-ITCH-001]" or "[FIN-ACMR, DOC-ACMR-001]". */
function inlineIds(answer: string): string[] {
  const ids = [...answer.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/[,;\s]+/));
  return [...new Set(ids.filter((id) => /^[A-Z]+(-[A-Z0-9]+)+$/.test(id)))];
}

const searchCitations = (b: Anthropic.TextBlock) =>
  (b.citations ?? []).filter((c): c is Anthropic.CitationsSearchResultLocation => c.type === "search_result_location");

/**
 * Splits the full answer into sentences and gives each one the citations of the
 * blocks it overlaps. Splitting the joined text (not block by block) matters: one
 * uncited block often runs on into the next sentence, and its numbers must not be
 * checked against a neighbour's citation.
 */
function sentences(blocks: Anthropic.TextBlock[]) {
  let full = "";
  const spans = blocks.map((b) => {
    const start = full.length;
    full += b.text;
    return { start, end: full.length, citations: searchCitations(b) };
  });

  // A sentence ends at . ! ? followed by space (so "47.1%" doesn't split), or at a line break.
  const ends = [...full.matchAll(/[.!?]["')\]]*(?=\s)|\n/g)].map((m) => m.index + m[0].length);
  const pieces: { text: string; citations: Anthropic.CitationsSearchResultLocation[] }[] = [];
  let start = 0;
  for (const end of [...ends, full.length]) {
    const raw = full.slice(start, end);
    const s = start + (raw.length - raw.trimStart().length);
    const e = start + raw.trimEnd().length;
    start = end;
    if (e <= s) continue;
    const citations = spans.filter((sp) => sp.start < e && sp.end > s).flatMap((sp) => sp.citations);
    pieces.push({ text: full.slice(s, e), citations });
  }
  return pieces;
}
