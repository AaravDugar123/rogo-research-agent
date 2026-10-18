/**
 * The agent's tools. These stand in for the real research APIs — same shapes,
 * local data, plus a little latency so the app behaves like the real thing.
 *
 * Each tool is split in two:
 * - fetch: the data lookup (latency plus finding the record). Errors are thrown here.
 * - shape: a pure function that turns the record into what the model reads.
 *   Keep anything that could change the answer, drop anything that can't.
 *
 * Successful tools return search_result blocks, so the API can attach citations
 * to the answer. Each text block is one fact (a fiscal year, a sentence), because
 * Claude cites whole blocks.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  companies,
  documents,
  financials,
  type Company,
  type FinancialRecord,
  type ResearchDocument,
} from "./data.ts";

/** Thrown when a tool cannot service a request. The message tells the model how to recover. */
export class ToolError extends Error {}

type SearchResult = Anthropic.SearchResultBlockParam;

/**
 * search_result blocks, or a plain string when there is nothing to return.
 * The API rejects an empty search_result, and a tool_result can't mix the two.
 */
export type ToolOutput = SearchResult[] | string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_SEARCH_TERMS = 6;

export const toolSchemas: Anthropic.Tool[] = [
  {
    name: "searchCompanies",
    description:
      "Find companies in the coverage universe by name or ticker (case-insensitive, partial match). An empty query lists every company. Returns name, ticker and sector.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'A company name, part of one, or a ticker, e.g. "Acme" or "GLBX".' },
      },
      required: ["query"],
    },
  },
  {
    name: "getCompanyProfile",
    description:
      "Get a company's profile: description, sector, headquarters, headcount, business segments with share of revenue, and the filings we hold (form, period, filing date). Accepts a name or ticker. If the name matches more than one company, the error lists the candidates.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", description: 'Company name or ticker, e.g. "Globex" or "GLBX".' },
      },
      required: ["company"],
    },
  },
  {
    name: "getFinancials",
    description:
      "Get a company's reported financials in USD millions: one line per fiscal year (revenue, gross margin, operating income, net income, free cash flow) and one line per quarter (revenue, gross margin, operating income). Data warnings, such as unfiled or unaudited periods, are listed first. Accepts a name or ticker. If the name matches more than one company, the error lists the candidates.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", description: 'Company name or ticker, e.g. "Acme Robotics" or "ACMR".' },
      },
      required: ["company"],
    },
  },
  {
    name: "searchDocuments",
    description: `Keyword search over earnings call transcripts, filing excerpts and press releases. Uses at most ${MAX_SEARCH_TERMS} keywords (extra words are ignored, as are common words like "the" or "what"). Matching is case-insensitive and ignores plurals. Returns up to 5 documents, each with its ID, form and date. To list every document for one company, pass that company with an empty query.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Keywords, e.g. "acquisitions organic growth". May be empty if company is given.' },
        company: {
          type: "string",
          description: "Optional. Company name or ticker to restrict the search to.",
        },
      },
      required: ["query"],
    },
  },
];

// ---------- Company lookup ----------

const companyList = () => companies.map((c) => `${c.name} (${c.ticker})`).join(", ");

const normalize = (s: string) => s.toLowerCase().replace(/[.,$]/g, "").replace(/\s+/g, " ").trim();

/**
 * Find one company from a name or ticker. Never guesses: several matches or none
 * throw an error listing the options. Order matters:
 * 1. Exact uppercase ticker ("ACME"). Case-sensitive on purpose: Acme Corp's ticker
 *    is ACME, so a case-insensitive check would quietly turn "Acme" into Acme Corp.
 * 2. Exact name, ignoring case ("acme corp").
 * 3. Partial name, only if exactly one company matches ("Globex" -> Globex Inc).
 * 4. Ticker, ignoring case ("glbx").
 */
export function resolveCompany(input: string): Company {
  const raw = String(input ?? "").trim();
  const q = normalize(raw);
  if (!q) throw new ToolError(`No company given. Valid companies: ${companyList()}.`);

  const byTicker = companies.find((c) => c.ticker === raw.replace(/^\$/, ""));
  if (byTicker) return byTicker;

  const exact = companies.find((c) => normalize(c.name) === q);
  if (exact) return exact;

  const partial = companies.filter((c) => normalize(c.name).includes(q) || q.includes(normalize(c.name)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const options = partial.map((c) => `${c.name} (${c.ticker})`).join(", ");
    throw new ToolError(`"${input}" is ambiguous: ${options}. Call again with one of these.`);
  }

  const tickerAnyCase = companies.find((c) => c.ticker.toLowerCase() === q);
  if (tickerAnyCase) return tickerAnyCase;

  throw new ToolError(`No company matches "${input}". Valid companies: ${companyList()}.`);
}

// ---------- Shape functions (pure, no I/O) ----------

const text = (t: string): Anthropic.TextBlockParam => ({ type: "text", text: t });
const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

function result(source: string, title: string, lines: string[]): SearchResult {
  return { type: "search_result", source, title, content: lines.map(text), citations: { enabled: true } };
}

export function shapeCompanyList(matches: Company[]): SearchResult {
  return result(
    "companies",
    "Coverage universe",
    matches.map((c) => `${c.name} (${c.ticker}): ${c.sector}`),
  );
}

export function shapeProfile(c: Company): SearchResult {
  return result(`profile:${c.ticker}`, `${c.name} (${c.ticker}) company profile`, [
    `${c.name} (${c.ticker}) is in ${c.sector}, headquartered in ${c.hq}, founded ${c.founded}, with ${c.employees.toLocaleString("en-US")} employees.`,
    c.description,
    ...c.segments.map((s) => `Segment ${s.name}: ${pct(s.shareOfRevenue)} of revenue.`),
    ...c.filings.map((f) => `Filing ${f.id}: ${f.form} for ${f.period}, filed ${f.filedOn}.`),
  ]);
}

/**
 * Warnings first, one line per fiscal year, then every quarter, restatements as a note.
 * No period is cut: which years or quarters matter depends on the question.
 * Dropped: checksum, pipeline version, ingest time and source system, which can't change an answer.
 * Margins are written as percents so the model's numbers match the source text directly.
 */
export function shapeFinancials(r: FinancialRecord): SearchResult {
  const annual = r.annual.map((y) =>
    y.revenue === null
      ? `FY${y.fiscalYear}: not filed. No reported figures.`
      : `FY${y.fiscalYear}: revenue ${y.revenue}, gross margin ${pct(y.grossMargin!)}, operating income ${y.operatingIncome}, net income ${y.netIncome}, free cash flow ${y.freeCashFlow}.`,
  );
  const quarters = r.quarterly.map((q) => `${q.period}: revenue ${q.revenue}, gross margin ${pct(q.grossMargin)}, operating income ${q.operatingIncome}.`);
  return result(`financials:${r.ticker}`, `${r.company} (${r.ticker}) financials, ${r.currency} ${r.unit}`, [
    ...(r.warnings ?? []).map((w) => `WARNING: ${w}`),
    ...annual,
    ...quarters,
    ...r.provenance.restatements.map((s) => `Note: ${s.period} restated. ${s.note}`),
  ]);
}

/** One block per sentence. Splits only where a capital letter follows, so "$2.26 billion" stays whole. */
export function shapeDocument(d: ResearchDocument): SearchResult {
  const sentences = d.body.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return result(d.id, `${d.title} (${d.form}, ${d.date})`, sentences);
}

// ---------- Search helpers ----------

const STOPWORDS = new Set(
  "a an and are as at be by does do for from has have how in is it its of on or the to was what when which who why with".split(" "),
);

/** Lowercase keywords, stopwords removed, a trailing "s" stripped ("risks" -> "risk"), at most 6. */
export function searchTerms(query: string): string[] {
  const words = String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return [...new Set(words)].slice(0, MAX_SEARCH_TERMS);
}

// ---------- Tools: fetch, then shape ----------

async function searchCompanies(query: string): Promise<ToolOutput> {
  await sleep(250);
  const q = normalize(String(query ?? ""));
  const matches = companies.filter(
    (c) => normalize(c.name).includes(q) || q.includes(normalize(c.name)) || c.ticker.toLowerCase().includes(q),
  );
  if (!matches.length) return `No companies match "${query}". Valid companies: ${companyList()}.`;
  return [shapeCompanyList(matches)];
}

async function getCompanyProfile(company: string): Promise<ToolOutput> {
  await sleep(450);
  return [shapeProfile(resolveCompany(company))];
}

async function getFinancials(company: string): Promise<ToolOutput> {
  await sleep(800);
  const c = resolveCompany(company);
  const record = financials.find((f) => f.ticker === c.ticker);
  if (!record) throw new ToolError(`No financials on file for ${c.name} (${c.ticker}).`);
  return [shapeFinancials(record)];
}

async function searchDocuments(query: string, company?: string): Promise<ToolOutput> {
  await sleep(700);
  const target = company ? resolveCompany(company) : undefined;
  const pool = target ? documents.filter((d) => d.company === target.name) : documents;
  const terms = searchTerms(query);

  if (!terms.length) {
    if (!target) throw new ToolError("Give some keywords, a company, or both.");
    return pool.length ? pool.map(shapeDocument) : `No documents on file for ${target.name}.`;
  }

  const hits = pool
    .map((doc) => {
      const haystack = `${doc.title} ${doc.body}`.toLowerCase();
      return { doc, score: terms.filter((t) => haystack.includes(t)).length };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!hits.length) {
    const scope = target ? ` for ${target.name}` : "";
    return `No documents matched "${terms.join(" ")}"${scope}. Try fewer or different keywords${target ? ", or an empty query to list all of its documents" : ""}.`;
  }
  return hits.map((h) => shapeDocument(h.doc));
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  switch (name) {
    case "searchCompanies":
      return searchCompanies(input.query as string);
    case "getCompanyProfile":
      return getCompanyProfile(input.company as string);
    case "getFinancials":
      return getFinancials(input.company as string);
    case "searchDocuments":
      return searchDocuments(input.query as string, input.company as string | undefined);
    default:
      throw new ToolError(`Unknown tool "${name}". Available: ${toolSchemas.map((t) => t.name).join(", ")}.`);
  }
}
