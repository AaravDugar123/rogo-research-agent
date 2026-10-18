import { describe, expect, it } from "vitest";
import { documents } from "./data.ts";
import { executeTool, resolveCompany, searchTerms, shapeDocument, ToolError, type ToolOutput } from "./tools.ts";

/** Every successful tool must return non-empty search_result blocks (API rules) titled with their ID. */
function expectSearchResults(out: ToolOutput) {
  expect(Array.isArray(out)).toBe(true);
  const blocks = out as Exclude<ToolOutput, string>;
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) {
    expect(b.type).toBe("search_result");
    expect(b.content.length).toBeGreaterThan(0);
    for (const c of b.content) {
      expect(c.type).toBe("text");
      expect(c.text.trim()).not.toBe("");
    }
    expect(b.citations?.enabled).toBe(false); // one setting for all results, as the API requires
    expect(b.title.startsWith(`${b.source}: `)).toBe(true); // the ID the model cites inline
  }
  return blocks;
}

const sources = (out: ToolOutput) => expectSearchResults(out).map((b) => b.source);

const lines = (out: ToolOutput) => expectSearchResults(out).flatMap((b) => b.content.map((c) => c.text));

describe("resolveCompany", () => {
  it("accepts a ticker", () => {
    expect(resolveCompany("GLBX").name).toBe("Globex Inc");
  });

  it("ignores case", () => {
    expect(resolveCompany("acme corp").ticker).toBe("ACME");
    expect(resolveCompany("itch").name).toBe("Initech");
  });

  it("accepts a unique partial name, ignoring corporate suffixes and possessives", () => {
    expect(resolveCompany("Globex").ticker).toBe("GLBX");
    expect(resolveCompany("Robotics").ticker).toBe("ACMR");
    expect(resolveCompany("Acme Robotics Inc.").ticker).toBe("ACMR");
    expect(resolveCompany("Globex Corp").ticker).toBe("GLBX");
    expect(resolveCompany("Initech's").ticker).toBe("ITCH");
  });

  it("does not match fragments or pick one company out of several named", () => {
    expect(() => resolveCompany("x")).toThrow(/No company matches/);
    expect(() => resolveCompany("tech")).toThrow(/No company matches/);
    expect(() => resolveCompany("Acme Corp vs Globex")).toThrow(/one company per call/);
  });

  it("treats an uppercase ticker as exact, even when it looks like a name", () => {
    expect(resolveCompany("ACME").name).toBe("Acme Corp");
  });

  it("refuses to guess between the two Acmes", () => {
    expect(() => resolveCompany("acme")).toThrow(ToolError);
    expect(() => resolveCompany("Acme")).toThrow(ToolError);
    expect(() => resolveCompany("Acme")).toThrow(
      '"Acme" is ambiguous: Acme Corp (ACME), Acme Robotics (ACMR). Call again with one of these.',
    );
  });

  it("lists every valid company when nothing matches", () => {
    expect(() => resolveCompany("Hooli")).toThrow(/Valid companies: .*Globex Inc \(GLBX\).*Umbrella Health \(UMBR\)/);
  });
});

describe("tools", () => {
  it("searchCompanies matches tickers", async () => {
    expect(lines(await executeTool("searchCompanies", { query: "ITCH" }))).toEqual(["Initech (ITCH): Enterprise Software"]);
  });

  it("getFinancials accepts a ticker and puts Initech warnings first", async () => {
    const out = lines(await executeTool("getFinancials", { company: "ITCH" }));
    expect(out[0]).toMatch(/^WARNING: FY2025 has not been filed/);
    expect(out[1]).toMatch(/^WARNING: FY2023 professional services revenue is unaudited/);
    expect(out).toContain("FY2025: not filed. No reported figures.");
  });

  it("getFinancials drops pipeline metadata and keeps every quarter", async () => {
    const out = await executeTool("getFinancials", { company: "Acme Robotics" });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/checksum|sha256|pipeline|ingestedAt/i);
    expect(lines(out).filter((l) => / Q\d:/.test(l))).toHaveLength(20); // FY2021 to FY2025
    expect(lines(out)).toContain(
      // Hand-computed from data.ts: margin 0.514 + 4 * 0.004, operating margin 0.041 + 4 * 0.004 * 0.6.
      "FY2025: revenue 1015, gross margin 53.0%, operating income 51.4, net income 38, free cash flow 31.3.",
    );
  });

  it("getFinancials returns an error that names both Acmes", async () => {
    await expect(executeTool("getFinancials", { company: "acme" })).rejects.toThrow(/Acme Corp \(ACME\), Acme Robotics \(ACMR\)/);
  });

  it("searchDocuments does not throw on a long query", async () => {
    const out = await executeTool("searchDocuments", {
      query: "what are the biggest risks and acquisition concerns flagged in the latest filings",
    });
    expectSearchResults(out);
  });

  it("searchDocuments filters by ticker", async () => {
    const found = sources(await executeTool("searchDocuments", { query: "acquisitions", company: "UMBR" }));
    expect(found).toContain("DOC-UMBR-002");
    expect(found.every((s) => s.startsWith("DOC-UMBR-"))).toBe(true);
  });

  it("searchDocuments matches plurals to singulars", async () => {
    // DOC-ACME-002 says "the loss of any one of them"; the query says "losses".
    expect(sources(await executeTool("searchDocuments", { query: "losses", company: "ACME" }))).toEqual(["DOC-ACME-002"]);
  });

  it("searchDocuments searches the form and matches whole words, not fragments", async () => {
    expect(sources(await executeTool("searchDocuments", { query: "8-K" }))).toEqual(["DOC-ITCH-001"]);
    // "us" appears inside "customers" and "focused" but never as a word.
    expect(typeof (await executeTool("searchDocuments", { query: "us" }))).toBe("string");
  });

  it("searchDocuments with only common words and no company is an error", async () => {
    await expect(executeTool("searchDocuments", { query: "what is the" })).rejects.toThrow(/searchable/);
  });

  it("searchDocuments with an empty query lists all of a company's documents", async () => {
    const blocks = expectSearchResults(await executeTool("searchDocuments", { query: "", company: "Initech" }));
    expect(blocks.map((b) => b.source).sort()).toEqual(["DOC-ITCH-001", "DOC-ITCH-002"]);
  });

  it("searchDocuments returns a plain string, not an empty result, when nothing matches", async () => {
    const out = await executeTool("searchDocuments", { query: "blockchain", company: "Globex" });
    expect(typeof out).toBe("string");
  });

  it("every tool returns search_result blocks on success", async () => {
    expectSearchResults(await executeTool("searchCompanies", { query: "" }));
    expectSearchResults(await executeTool("getCompanyProfile", { company: "UMBR" }));
    expectSearchResults(await executeTool("getFinancials", { company: "Globex" }));
    expectSearchResults(await executeTool("searchDocuments", { query: "organic growth" }));
  });
});

describe("searchTerms", () => {
  it("drops stopwords, makes plurals singular and keeps the first 6", () => {
    expect(searchTerms("What are the risks of the acquisitions")).toEqual(["risk", "acquisition"]);
    expect(searchTerms("losses companies status analysis 10-K")).toEqual(["loss", "company", "status", "analysis", "10-k"]);
    expect(searchTerms("one two three four five six seven eight")).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(searchTerms("Acme's growth")).toEqual(["acme", "growth"]);
  });
});

describe("shapeDocument", () => {
  it("splits every document into sentences without losing text", () => {
    for (const d of documents) {
      const sentences = shapeDocument(d).content.map((c) => c.text);
      expect(sentences.join(" ")).toBe(d.body);
      expect(sentences.length).toBeGreaterThan(1);
    }
  });
});
