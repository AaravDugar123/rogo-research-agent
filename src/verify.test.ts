import { describe, expect, it } from "vitest";
import { checkPiece, extractNumbers, growthRates } from "./verify.ts";

const raws = (nums: { raw: string }[]) => nums.map((n) => n.raw);

describe("extractNumbers", () => {
  it("strips $ and commas, converts billions to millions, marks percents", () => {
    expect(extractNumbers("Revenue was $2.26 billion, or 2,260 million, up 5.5%.")).toEqual([
      { raw: "$2.26 billion", value: 2260, percent: false, halfUnit: 5 },
      { raw: "2,260 million", value: 2260, percent: false, halfUnit: 0.5 },
      { raw: "5.5%", value: 5.5, percent: true, halfUnit: 0.05 },
    ]);
  });

  it("ignores years, fiscal periods, form names and small integers", () => {
    expect(extractNumbers("In FY2025 Q4, filed in 2026, the 10-K and 8-K listed 12 clinics and 9% growth.")).toEqual([]);
  });

  it("lets the first number of a range borrow the unit", () => {
    expect(extractNumbers("about $1.12 to $1.14 billion").map((n) => n.value)).toEqual([1120, 1140]);
  });
});

describe("growthRates", () => {
  it("computes growth for ordered pairs", () => {
    const rates = growthRates([690, 1015]);
    expect(rates).toHaveLength(2);
    expect(rates[0]).toBeCloseTo(47.1, 1); // 690 -> 1015
  });
});

describe("checkPiece", () => {
  const acmr = "FY2024: revenue 690, gross margin 52.6%. FY2025: revenue 1015, gross margin 53.0%.";

  it("passes a number that appears in the cited text", () => {
    expect(checkPiece("FY2025 revenue was $1,015 million.", acmr)).toEqual([]);
  });

  it("passes a growth rate derived from the cited text", () => {
    expect(checkPiece("Revenue grew 47.1% in FY2025.", acmr)).toEqual([]);
  });

  it("flags a percent that matches nothing", () => {
    const cited = "Full-year revenue came in at $2.26 billion, up 5.5% over FY2024.";
    expect(raws(checkPiece("Revenue grew 6.5%.", cited))).toEqual(["6.5%"]);
  });

  it("compares billions written in the answer with millions in the source", () => {
    expect(checkPiece("Revenue was about $1.0 billion.", acmr)).toEqual([]);
    expect(raws(checkPiece("Revenue was $2.62 billion.", "FY2025: revenue 2260."))).toEqual(["$2.62 billion"]);
  });

  it("passes margins and differences computed from the cited text", () => {
    const fy25 = "FY2025: revenue 1015, gross margin 53.0%, operating income 51.4.";
    expect(checkPiece("Operating margin was 5.1% in FY2025.", fy25)).toEqual([]); // 51.4 / 1015
    expect(checkPiece("Revenue rose by $325 million.", acmr)).toEqual([]); // 1015 - 690
    expect(checkPiece("Gross margin expanded 0.4 points.", acmr)).toEqual([]); // 53.0 - 52.6
  });

  it("still flags a CAGR, which it does not derive", () => {
    const span = "FY2021: revenue 210. FY2025: revenue 1015.";
    expect(raws(checkPiece("Revenue compounded at 48.3% a year.", span))).toEqual(["48.3%"]);
  });

  it("does not treat years as figures", () => {
    expect(checkPiece("In 2025 and FY2024, revenue was 1015.", acmr)).toEqual([]);
  });
});
