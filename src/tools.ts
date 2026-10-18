/**
 * The agent's tools. These stand in for the real research APIs — same shapes,
 * local data, plus a little latency so the app behaves like the real thing.
 *
 * Each tool is split in two:
 * - fetch: the data lookup (latency plus finding the record). Errors are thrown here.
 * - shape: a pure function that turns the record into what the model reads.
 *   Keep anything that could change the answer, drop anything that can't.
 *
 * Successful tools return search_result blocks. Each has a source ID (e.g. FIN-ACMR,
 * DOC-ITCH-001) that the model cites inline, and each text block is one fact (a fiscal
 * year, a sentence).
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
      "Get a company's reported financials in USD millions: one line per fiscal year (revenue, gross margin, operating income, net income, free cash flow) and one line per quarter (revenue, gross margin, operating income). Data warnings, such as unfiled or unaudited periods, are listed first; restatement notes come last. Accepts a name or ticker. If the name matches more than one company, the error lists the candidates.",
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
    description: `Keyword search over earnings call transcripts, filing excerpts and press releases. Searches each document's title, text, form (e.g. "8-K", "10-K"), company name and ticker. Uses at most ${MAX_SEARCH_TERMS} keywords (extra words are ignored, as are common words like "the" or "what"). Case-insensitive; plurals match singulars. A document matches if it contains any keyword, ranked by how many it contains. Returns up to 5 documents, each with its ID, form and date. Documents use their own wording, so if a keyword search misses, list every document for the company by passing it with an empty query.`,
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

const SUFFIXES = new Set(["inc", "corp", "corporation", "co", "ltd", "llc", "plc"]);

/** Query words without a possessive or corporate suffix: "Globex Corp's" -> ["globex"]. */
const queryWords = (s: string) =>
  s.toLowerCase().replace(/'s\b/g, "").split(/[^a-z0-9&]+/).filter((w) => w && !SUFFIXES.has(w));

/** Every query word starts a word of the name: "acme rob" -> Acme Robotics, but "x" matches nothing. */
const matchesName = (c: Company, words: string[]) =>
  words.length > 0 && words.every((w) => c.name.toLowerCase().split(" ").some((n) => n.startsWith(w)));

/**
 * Find one company from a name or ticker. Never guesses: several matches or none
 * throw an error listing the options. Order matters:
 * 1. Exact uppercase ticker ("ACME"). Case-sensitive on purpose: Acme Corp's ticker
 *    is ACME, so a case-insensitive check would quietly turn "Acme" into Acme Corp.
 * 2. Exact name, ignoring case ("acme corp").
 * 3. Partial name, only if exactly one company matches ("Globex" -> Globex Inc).
 *    Input naming two companies ("Acme Corp vs Globex") matches neither, so it errors.
 * 4. Ticker, ignoring case ("glbx").
 */
export function resolveCompany(input: string): Company {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ToolError(`No company given. Valid companies: ${companyList()}.`);

  const byTicker = companies.find((c) => c.ticker === raw.replace(/^\$/, ""));
  if (byTicker) return byTicker;

  const exact = companies.find((c) => normalize(c.name) === normalize(raw));
  if (exact) return exact;

  const partial = companies.filter((c) => matchesName(c, queryWords(raw)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const options = partial.map((c) => `${c.name} (${c.ticker})`).join(", ");
    throw new ToolError(`"${input}" is ambiguous: ${options}. Call again with one of these.`);
  }

  const tickerAnyCase = companies.find((c) => c.ticker.toLowerCase() === raw.replace(/^\$/, "").toLowerCase());
  if (tickerAnyCase) return tickerAnyCase;

  throw new ToolError(`No company matches "${input}". Pass one company per call. Valid companies: ${companyList()}.`);
}

// ---------- Shape functions (pure, no I/O) ----------

const text = (t: string): Anthropic.TextBlockParam => ({ type: "text", text: t });
const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/**
 * The source ID also leads the title ("FIN-ACMR: Acme Robotics financials ..."), so the
 * model can see it and cite it inline as [FIN-ACMR].
 * API citations are off: with them on, the model copied cited source lines into its
 * prose (see bench-results/baseline.md), and inline IDs are the citations the analyst sees.
 */
function result(source: string, title: string, lines: string[]): SearchResult {
  return { type: "search_result", source, title: `${source}: ${title}`, content: lines.map(text), citations: { enabled: false } };
}

export function shapeCompanyList(matches: Company[]): SearchResult {
  return result(
    "COMPANIES",
    "Coverage universe",
    matches.map((c) => `${c.name} (${c.ticker}): ${c.sector}`),
  );
}

export function shapeProfile(c: Company): SearchResult {
  return result(`PROFILE-${c.ticker}`,`${c.name} (${c.ticker}) company profile`, [
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
  return result(`FIN-${r.ticker}`,`${r.company} (${r.ticker}) financials, ${r.currency} ${r.unit}`, [
    ...(r.warnings ?? []).map((w) => `WARNING: ${w}`),
    ...annual,
    ...quarters,
    ...r.provenance.restatements.map((s) => `Note: ${s.period} restated. ${s.note}`),
  ]);
}

/** One block per sentence. Splits only where a capital letter follows, so "$2.26 billion" stays whole. */
export function shapeDocument(d: ResearchDocument): SearchResult {
  const sentences = d.body.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim()); // the API rejects empty text
  return result(d.id, `${d.title} (${d.form}, ${d.date})`, sentences);
}

// ---------- Search helpers ----------

const STOPWORDS = new Set(
  ("a about all an and any are as at be biggest by can did do does flag flagged flags for from give has have how " +
    "in is it its key latest main me mentioned most my of on or recent show tell that the their them there these " +
    "this those to was what when which who why with").split(" "),
);

/** Words as search sees them. Keeps "10-k", "8-k" and "m&a" whole. */
const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9&-]+/).filter((w) => w.length > 1);

/** Singular form, so "risks" matches "risk". Leaves "loss", "status", "analysis" alone. */
export function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y"; // companies -> company
  if (/(sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2); // losses -> loss
  if (w.endsWith("s")) return w.slice(0, -1); // risks -> risk
  return w;
}

/** Lowercase keywords in singular form, stopwords removed, at most 6. */
export function searchTerms(query: string): string[] {
  const words = tokenize(String(query ?? "")).filter((w) => !STOPWORDS.has(w)).map(singular);
  return [...new Set(words)].slice(0, MAX_SEARCH_TERMS);
}

/** A term matches a word it starts, so "risk" matches "risks" but "us" doesn't match "customers". */
function docMatches(doc: ResearchDocument, terms: string[]): number {
  const ticker = companies.find((c) => c.name === doc.company)?.ticker ?? "";
  const words = tokenize(`${doc.title} ${doc.form} ${doc.company} ${ticker} ${doc.body}`).map(singular);
  return terms.filter((t) => words.some((w) => w.startsWith(t))).length;
}

// ---------- Tools: fetch, then shape ----------

async function searchCompanies(query: string): Promise<ToolOutput> {
  await sleep(250);
  const q = String(query ?? "").trim().replace(/^\$/, "").toLowerCase();
  const matches = q
    ? companies.filter((c) => matchesName(c, queryWords(q)) || c.ticker.toLowerCase() === q)
    : companies;
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
  const target = company?.trim() ? resolveCompany(company) : undefined;
  const pool = target ? documents.filter((d) => d.company === target.name) : documents;
  const terms = searchTerms(query);

  if (!terms.length) {
    if (!target) {
      throw new ToolError(
        String(query ?? "").trim()
          ? `None of the words in "${query}" are searchable (common words are ignored). Use specific keywords, or pass a company.`
          : "Give some keywords, a company, or both.",
      );
    }
    return pool.length ? pool.map(shapeDocument) : `No documents on file for ${target.name}.`;
  }

  const hits = pool
    .map((doc) => ({ doc, score: docMatches(doc, terms) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!hits.length) {
    const scope = target ? ` for ${target.name}` : "";
    return `No documents matched "${query}"${scope}. Try fewer or different keywords${target ? ", or an empty query to list all of its documents" : ""}.`;
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
