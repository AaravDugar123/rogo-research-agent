/**
 * Benchmark for the research agent. Runs a fixed set of questions through
 * runAgent and records speed, cost and simple answer-quality checks.
 *
 *   npx tsx scripts/bench.ts --label baseline --runs 2
 *   npx tsx scripts/bench.ts --label smoke --runs 1 --only 7
 *
 * It only relies on runAgent(question, onEvent) and result.answer, so the same
 * script runs against the original agent.ts and the improved one. Model calls
 * and tokens are counted by wrapping the SDK's messages.create, so agent.ts
 * needs no changes to be measured.
 */

import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../src/agent.ts";
import { financials } from "../src/data.ts";

// ---------- Questions and checks ----------

interface Check {
  name: string;
  pass: (answer: string, toolErrors: number) => boolean;
}

const coversBothAcmes: Check = {
  name: "covers both Acmes or asks which",
  pass: (a) =>
    (/acme corp/i.test(a) && /acme robotics/i.test(a)) ||
    /(which acme\b|did you mean|do you mean)[^.!?]*\?/i.test(a),
};
const flagsUnfiled: Check = {
  name: "flags preliminary/unfiled data",
  pass: (a) =>
    /preliminary|unaudited|(not|n't) (yet )?(been )?filed|unfiled|yet to (be )?file|delayed/i.test(a),
};
const namesAcmeRobotics: Check = {
  name: "names Acme Robotics",
  pass: (a) => /acme robotics|\bACMR\b/i.test(a),
};
const noToolErrors: Check = {
  name: "zero tool errors",
  pass: (_a, toolErrors) => toolErrors === 0,
};
const mentionsAcquisitions: Check = {
  name: "mentions acquisitions or organic growth",
  pass: (a) => /acqui|organic|bolt-on/i.test(a),
};

// Q1 to Q5 are the README's "Try it" prompts. Q6 and Q7 target the Acme
// ambiguity and the unfiled Initech FY2025 directly.
const QUESTIONS = [
  { id: 1, text: "Compare Acme and Globex and tell me which one appears to be growing faster.", checks: [coversBothAcmes, mentionsAcquisitions] },
  { id: 2, text: "What are the biggest risks Umbrella Health flags in its filings?", checks: [mentionsAcquisitions] },
  { id: 3, text: "How is Initech's subscription transition going?", checks: [flagsUnfiled] },
  { id: 4, text: "Which company in the universe is growing fastest?", checks: [namesAcmeRobotics] },
  { id: 5, text: "Is GLBX a better business than ITCH?", checks: [noToolErrors] },
  { id: 6, text: "What was Acme's revenue growth last year?", checks: [coversBothAcmes] },
  { id: 7, text: "What was Initech's FY2025 revenue?", checks: [flagsUnfiled] },
];

// ---------- Number check ----------
// Is each number in the answer found in what the tools returned in that run?
// Plain code, no model. Reported only, never used to pass or fail a question.

interface Num {
  raw: string;
  value: number; // "$2.26 billion" -> 2260, since the data is in USD millions
  halfUnit: number; // rounding slack implied by how it was written ("$1.0B" -> 50)
  isYear: boolean; // "2025", but not "$2,025" or "2025 million"
  isSmallInt: boolean; // "Q4", "10-K", counts
}

// Groups: $, integer part, decimals, unit, and the unit of a range's second
// number ("$1.12 to $1.14 billion"), which the first number borrows.
const UNIT = String.raw`(billion|bn|b|million|mm|m)\b(?!&)`;
const NUMBER = new RegExp(
  String.raw`(?<![\w.])(\$?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*${UNIT})?` +
    String.raw`(?=(?:\s*(?:-|–|to)\s*\$?[\d.,]+\s*${UNIT})?)`,
  "gi",
);

function extractNumbers(text: string): Num[] {
  return [...text.matchAll(NUMBER)].map(([raw, dollar, int, dec, ownUnit, rangeUnit]) => {
    const unit = ownUnit ?? rangeUnit;
    const scale = unit && /^b/i.test(unit) ? 1000 : 1;
    const n = Number(int.replace(/,/g, "") + (dec ? `.${dec}` : ""));
    const isYear = !dollar && !dec && !unit && !int.includes(",") && n >= 1900 && n <= 2100;
    const isSmallInt = !dec && !unit && n <= 31;
    return { raw: raw.trim(), value: n * scale, halfUnit: 0.5 * 10 ** -(dec?.length ?? 0) * scale, isYear, isSmallInt };
  });
}

/**
 * Every number in the source text, plus fractions as percents (0.381 -> 38.1).
 * Bare years are dropped here too, or "$2.0 billion" would match "2021".
 * Known cost: Acme Corp revenues 1975 and 2088 look like years and are dropped.
 */
function sourceNumbers(text: string): number[] {
  return extractNumbers(text)
    .filter((n) => !n.isYear)
    .flatMap((n) => (n.value < 1 ? [n.value, n.value * 100] : [n.value]));
}

// Year-over-year revenue growth pairs from the fixture, so "grew 47.1%" can be
// grounded even though no tool states that number directly. Revenue only, to
// keep this pool small (more derived numbers would match almost anything).
const REVENUE_GROWTH = financials.flatMap((f) =>
  f.annual.slice(1).flatMap((cur, i) => {
    const prev = f.annual[i].revenue;
    return prev && cur.revenue ? [{ from: prev, to: cur.revenue, rate: ((cur.revenue - prev) / prev) * 100 }] : [];
  }),
);

function groundNumbers(answer: string, toolText: string) {
  const fetched = sourceNumbers(toolText);
  // A growth rate only counts if both revenues it comes from were in the tool output.
  const derived = REVENUE_GROWTH.filter((g) => fetched.includes(g.from) && fetched.includes(g.to)).map((g) => g.rate);
  const pool = [...fetched, ...derived].map(Math.abs);
  const nums = extractNumbers(answer).filter((n) => !n.isYear && !n.isSmallInt);
  const ungrounded = nums.filter(
    (n) => !pool.some((s) => Math.abs(Math.abs(n.value) - s) <= Math.max(0.15, 0.01 * s, n.halfUnit)),
  );
  return { checked: nums.length, grounded: nums.length - ungrounded.length, ungrounded: ungrounded.map((n) => n.raw) };
}

// ---------- Counting model calls, tokens and tool outputs ----------

interface CallRecord {
  model: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Runs execute in parallel, so each run gets its own state. AsyncLocalStorage
// carries the current run through every await inside runAgent, so the patched
// SDK methods below know which run is calling them.
interface RunState {
  calls: CallRecord[];
  toolOutputs: Map<string, string>; // tool_use_id -> text the model was given
  createCalls: number; // messages.create calls started
  httpRequests: number; // HTTP attempts; more than createCalls means the SDK retried
}
const currentRun = new AsyncLocalStorage<RunState>();

// Count HTTP attempts by wrapping the client's fetch. The SDK reads client.fetch
// on every attempt, so a retry after a 429 or 5xx is counted. A retry means that
// run's wall time includes backoff waiting, so its timing can't be trusted.
const countedClients = new WeakSet<object>();
function countRequests(client: any) {
  if (countedClients.has(client)) return;
  countedClients.add(client);
  const baseFetch = client.fetch;
  client.fetch = (...args: unknown[]) => {
    const state = currentRun.getStore();
    if (state) state.httpRequests++;
    return baseFetch(...args);
  };
}

/** Text of a tool_result's content: a plain string, or text / search_result blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (b?.type === "text") return b.text;
      if (b?.type === "search_result") return `${b.title}\n${contentText(b.content)}`;
      return "";
    })
    .join("\n");
}

// Wrap the SDK method on the prototype, so the client created inside agent.ts
// is measured without editing agent.ts. Tool results are read from each request,
// because that is exactly what the model was shown.
const originalCreate = Anthropic.Messages.prototype.create;
Anthropic.Messages.prototype.create = function (this: any, params: any, options?: any) {
  const state = currentRun.getStore();
  if (!state) return originalCreate.call(this, params, options);
  countRequests(this._client);
  state.createCalls++;
  for (const msg of params.messages ?? []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") state.toolOutputs.set(block.tool_use_id, contentText(block.content));
    }
  }
  // Return the SDK's own promise untouched and record usage on the side.
  // Assumes non-streaming calls, which is what agent.ts makes.
  const pending = originalCreate.call(this, params, options);
  pending.then((res: any) => {
    state.calls.push({
      model: params.model,
      stopReason: res.stop_reason ?? null,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      // Cached input is billed separately. Recorded so prompt caching can't hide cost.
      cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage?.cache_creation_input_tokens ?? 0,
    });
  }, () => {});
  return pending;
} as any;

// ---------- Run ----------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const label = arg("label", "run");
const runs = Number(arg("runs", "1"));
const only = arg("only", "").split(",").filter(Boolean).map(Number);
const selected = only.length ? QUESTIONS.filter((q) => only.includes(q.id)) : QUESTIONS;
// How many agent runs execute at once. Each run is still timed on its own.
// Use the same value for the runs you compare.
const concurrency = Number(arg("concurrency", "4"));

const outPath = `bench-results/${label}.json`;

if (!/^[\w-]+$/.test(label)) throw new Error(`--label must be letters, digits, - or _ (got "${label}")`);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
if (!selected.length) throw new Error("--only matched no question ids (use 1 to 7)");
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Create .env from .env.example first.");
  process.exit(1);
}

// Imported after the key check, because agent.ts creates its client on load.
const { runAgent } = await import("../src/agent.ts");

async function runOne(run: number, q: (typeof QUESTIONS)[number]) {
  const state: RunState = { calls: [], toolOutputs: new Map(), createCalls: 0, httpRequests: 0 };
  let toolCalls = 0;
  let toolErrors = 0;
  const onEvent = (e: AgentEvent) => {
    if (e.type === "tool_start") toolCalls++;
    if (e.type === "tool_failed") toolErrors++;
  };

  const started = Date.now();
  let answer = "";
  let error: string | undefined;
  let extras: Record<string, unknown> = {};
  try {
    const result = await currentRun.run(state, () => runAgent(q.text, onEvent));
    answer = result.answer;
    // Fields the improved agent adds. Absent on the baseline.
    const { verification, citations, truncated, stats } = result as unknown as Record<string, unknown>;
    extras = { verification, citations, truncated, stats };
  } catch (err) {
    error = String(err);
  }
  const wallMs = Date.now() - started;

  const { calls } = state;
  const record = {
    question: q.id,
    run,
    text: q.text,
    wallMs,
    modelCalls: calls.length,
    apiRetries: state.httpRequests - state.createCalls,
    toolCalls,
    toolErrors,
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    checks: q.checks.map((c) => ({ name: c.name, pass: !error && c.pass(answer, toolErrors) })),
    numbers: groundNumbers(answer, [...state.toolOutputs.values()].join("\n")),
    error,
    answer,
    calls,
    extras,
  };
  console.error(
    `[bench] run ${run} Q${q.id}: ${(wallMs / 1000).toFixed(1)}s, ${record.modelCalls} model calls` +
      `${record.apiRetries ? `, ${record.apiRetries} API retries` : ""}${error ? `, ERROR ${error}` : ""}`,
  );
  return record;
}

// A small worker pool: `concurrency` workers pull the next job until none are left.
// Records are stored by job index, so the report order is stable.
const jobs = Array.from({ length: runs }, (_, i) => selected.map((q) => ({ run: i + 1, q }))).flat();
const records: Awaited<ReturnType<typeof runOne>>[] = [];
let nextJob = 0;
async function worker() {
  while (nextJob < jobs.length) {
    const i = nextJob++;
    records[i] = await runOne(jobs[i].run, jobs[i].q);
  }
}
const startedAt = new Date().toISOString();
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

// ---------- Report ----------

type RunRecord = Awaited<ReturnType<typeof runOne>>;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Headline stats for one benchmark. Stored in the JSON and printed as the summary table. */
function summarize(rs: RunRecord[]) {
  const checks = rs.flatMap((r) => r.checks);
  const checked = rs.reduce((s, r) => s + r.numbers.checked, 0);
  const grounded = rs.reduce((s, r) => s + r.numbers.grounded, 0);
  return {
    meanWallSeconds: round1(mean(rs.map((r) => r.wallMs)) / 1000),
    meanModelCalls: round1(mean(rs.map((r) => r.modelCalls))),
    meanToolCalls: round1(mean(rs.map((r) => r.toolCalls))),
    totalToolErrors: rs.reduce((s, r) => s + r.toolErrors, 0),
    meanInputTokens: Math.round(mean(rs.map((r) => r.inputTokens))),
    meanOutputTokens: Math.round(mean(rs.map((r) => r.outputTokens))),
    checksPassed: `${checks.filter((c) => c.pass).length}/${checks.length}`,
    numbersGrounded: `${grounded}/${checked}`,
    numbersGroundedPct: pct(grounded, checked),
    runsThatThrew: rs.filter((r) => r.error).length,
    apiRetries: rs.reduce((s, r) => s + (r.apiRetries ?? 0), 0), // absent in the first baseline
  };
}

// The label's JSON file keeps every benchmark of that label, each with the next id,
// so earlier results are never overwritten.
interface Benchmark {
  id: number;
  startedAt: string;
  models: string[];
  runs: number;
  concurrency: number;
  questions: number[];
  summary: ReturnType<typeof summarize>;
  records: RunRecord[];
}

function loadHistory(): { label: string; benchmarks: Benchmark[] } {
  if (!existsSync(outPath)) return { label, benchmarks: [] };
  const data = JSON.parse(readFileSync(outPath, "utf8"));
  if (Array.isArray(data.benchmarks)) return data;
  // Files written before ids existed held one benchmark at the top level. Keep it as id 1.
  // That first baseline ran questions one at a time, i.e. concurrency 1.
  const old = data.records as RunRecord[];
  return {
    label,
    benchmarks: [
      {
        id: 1,
        startedAt: data.startedAt,
        models: data.models,
        runs: data.runs,
        concurrency: 1,
        questions: [...new Set(old.map((r) => r.question))],
        summary: summarize(old),
        records: old,
      },
    ],
  };
}

const models = [...new Set(records.flatMap((r) => r.calls.map((c) => c.model)))];
const summary = summarize(records);
const history = loadHistory();
const id = Math.max(0, ...history.benchmarks.map((b) => b.id)) + 1;

const lines = [
  `## Benchmark: ${label} #${id}`,
  ``,
  `Model: ${models.join(", ") || "none"} | runs: ${runs} | concurrency: ${concurrency} | questions: ${selected.map((q) => q.id).join(", ")}`,
  ``,
  `| Q | Run | Wall (s) | Model calls | API retries | Tool calls | Tool errors | Input tok | Output tok | Checks | Numbers grounded |`,
  `|---|---|---|---|---|---|---|---|---|---|---|`,
  ...records.map((r) => {
    const passed = r.checks.filter((c) => c.pass).length;
    return `| ${r.question} | ${r.run} | ${(r.wallMs / 1000).toFixed(1)} | ${r.modelCalls} | ${r.apiRetries} | ${r.toolCalls} | ${r.toolErrors} | ${r.inputTokens} | ${r.outputTokens} | ${passed}/${r.checks.length} | ${r.numbers.grounded}/${r.numbers.checked} |`;
  }),
];

lines.push(
  ``,
  `| Summary | Value |`,
  `|---|---|`,
  `| Mean wall time (s) | ${summary.meanWallSeconds} |`,
  `| Mean model calls | ${summary.meanModelCalls} |`,
  `| Mean tool calls | ${summary.meanToolCalls} |`,
  `| Total tool errors | ${summary.totalToolErrors} |`,
  `| Mean input tokens | ${summary.meanInputTokens} |`,
  `| Mean output tokens | ${summary.meanOutputTokens} |`,
  `| Checks passed | ${summary.checksPassed} |`,
  `| Numbers grounded in tool output | ${summary.numbersGrounded} (${summary.numbersGroundedPct ?? "n/a"}%) |`,
  `| Runs that threw | ${summary.runsThatThrew} |`,
  `| API retries (if > 0, those runs' wall times include backoff) | ${summary.apiRetries} |`,
);

const failures = records.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- Q${r.question} run ${r.run}: ${c.name}`));
if (failures.length) lines.push(``, `Failed checks:`, ...failures);

console.log(lines.join("\n"));

history.benchmarks.push({
  id,
  startedAt,
  models,
  runs,
  concurrency,
  questions: selected.map((q) => q.id),
  summary,
  records,
});
mkdirSync("bench-results", { recursive: true });
writeFileSync(outPath, JSON.stringify(history, null, 2));
console.error(`[bench] added benchmark #${id} to ${outPath} (${history.benchmarks.length} total)`);
