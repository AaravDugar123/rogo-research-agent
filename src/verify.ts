/**
 * Deterministic number check for answers. Pure functions, no model calls.
 *
 * A number in an answer sentence passes if it is close to a number in the text that
 * sentence cites, or (for percents) close to a growth rate between two numbers in
 * that text. It catches "$2.62B" written for a source that says 2,260, which
 * embeddings and LLM reviewers can miss.
 */

export interface Num {
  raw: string;
  value: number; // "$2.26 billion" -> 2260, since the data is in USD millions
  percent: boolean;
  halfUnit: number; // rounding slack implied by how it was written: "$1.0B" -> 50, "47%" -> 0.5
}

// Groups: $, integer part, decimals, own suffix, and the suffix of a range's second
// number, which the first number borrows ("$1.12 to $1.14 billion", "13.5-15.2%").
const SUFFIX = String.raw`(%|percent\b|billion\b|bn\b|b\b|million\b|mm\b|m\b)(?!&)`;
const NUMBER = new RegExp(
  String.raw`(?<![\w.])(\$?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*${SUFFIX})?` +
    String.raw`(?=(?:\s*(?:-|–|to)\s*\$?[\d.,]+\s*${SUFFIX})?)`,
  "gi",
);

interface Parsed extends Num {
  isYear: boolean;
  isSmallInt: boolean;
}

function parse(text: string): Parsed[] {
  return [...text.matchAll(NUMBER)].map(([raw, dollar, int, dec, ownSuffix, rangeSuffix]) => {
    const suffix = (ownSuffix ?? rangeSuffix ?? "").toLowerCase();
    const percent = suffix === "%" || suffix === "percent";
    const scale = suffix.startsWith("b") ? 1000 : 1;
    const n = Number(int.replace(/,/g, "") + (dec ? `.${dec}` : ""));
    const isMoney = suffix !== "" && !percent;
    return {
      raw: raw.trim(),
      value: n * scale,
      percent,
      halfUnit: 0.5 * 10 ** -(dec?.length ?? 0) * scale,
      isYear: !dollar && !dec && !suffix && !int.includes(",") && n >= 1900 && n <= 2100,
      isSmallInt: !dec && !isMoney && n <= 31, // "Q4", "10-K", counts, "9%"
    };
  });
}

/** Numbers in the text worth checking: commas and $ stripped, billions in millions, years and small integers skipped. */
export function extractNumbers(text: string): Num[] {
  return parse(text)
    .filter((n) => !n.isYear && !n.isSmallInt)
    .map(({ raw, value, percent, halfUnit }) => ({ raw, value, percent, halfUnit }));
}

const pairs = (nums: number[], f: (a: number, b: number) => number | null) =>
  nums.flatMap((a, i) => nums.flatMap((b, j) => (i === j ? [] : [f(a, b)]))).filter((x): x is number => x !== null);

/** Growth in percent for every ordered pair: 690 -> 1015 gives 47.1. */
export function growthRates(nums: number[]): number[] {
  return pairs(nums, (a, b) => (a > 0 ? ((b - a) / a) * 100 : null));
}

/**
 * What an analyst commonly computes from two cited numbers, besides growth:
 * - ratios in percent, e.g. operating margin 51.4 / 1015 = 5.1%
 * - differences, e.g. revenue up 325 (690 to 1015), or margin up 0.4 points (52.6% to 53.0%)
 * Not covered: CAGR over several years and sums across companies, so those can still be flagged.
 */
function derivedValues(source: Parsed[]) {
  const plain = source.filter((n) => !n.percent).map((n) => n.value);
  const pcts = source.filter((n) => n.percent).map((n) => n.value);
  return {
    percents: [...growthRates(plain), ...pairs(plain, (a, b) => (b > 0 ? (a / b) * 100 : null))],
    differences: [...pairs(plain, (a, b) => b - a), ...pairs(pcts, (a, b) => b - a)],
  };
}

// Signs are compared loosely ("declined 2.5%" vs a -2.5 rate), so a wrong direction is not caught.
const close = (n: Num, s: number) =>
  Math.abs(Math.abs(n.value) - Math.abs(s)) <= Math.max(0.15, 0.01 * Math.abs(s), n.halfUnit);

/**
 * Numbers in `text` that match nothing in `citedText`: not directly, not as a growth
 * rate or ratio (for percents), and not as a difference. Empty means it checks out.
 */
export function checkPiece(text: string, citedText: string): Num[] {
  const source = parse(citedText).filter((n) => !n.isYear);
  const values = source.map((n) => n.value);
  const { percents, differences } = derivedValues(source);
  return extractNumbers(text).filter(
    (n) =>
      !values.some((s) => close(n, s)) &&
      !(n.percent && percents.some((r) => close(n, r))) &&
      !differences.some((d) => close(n, d)),
  );
}
