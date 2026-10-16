/**
 * Money / numeric helpers.
 *
 * Every monetary value that reaches a client or a stored record must pass
 * through round2 so that the same inputs always produce the same cents.
 * Half-up rounding on the 6-decimal rounded intermediate matches the
 * reference implementation used by questbase-estimating's verify-numbers suite.
 */

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const scaled = Number(Math.round(Number(Number(n).toFixed(6) + 'e2')) + 'e-2');
  return Number.isFinite(scaled) ? scaled : 0;
}

export function round(n: number, places = 0): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Coerce any input to a number. Accounting parentheses carry the sign. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    // Accounting notation: (1,200.00) is negative 1,200. The digit filter below
    // strips the parentheses, so the sign has to be detected BEFORE cleaning —
    // otherwise a parenthesised cost would be read as a positive amount.
    const parenthesised = /^\(.*\)$/.test(trimmed);
    const cleaned = trimmed.replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return 0;
    return parenthesised ? -Math.abs(n) : n;
  }
  return 0;
}

/** Non-negative money parse: parentheses and minus signs read as zero. */
export function money(v: unknown): number {
  const n = num(v);
  return n < 0 ? 0 : n;
}

/** Safe division — returns null instead of throwing on a zero denominator. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

export function pctOf(value: number, total: number): number {
  const r = ratio(value, total);
  return r === null ? 0 : r;
}

/**
 * Split `total` across percentages so the parts always sum to exactly `total`
 * (no lost or duplicated cents). Non-zero parts absorb rounding in sequence.
 */
export function allocateByPct(total: number, pcts: number[]): number[] {
  if (pcts.length === 0) return [];
  const sum = pcts.reduce((a, b) => a + b, 0);
  if (sum === 0) return pcts.map(() => 0);
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < pcts.length; i++) {
    if (i === pcts.length - 1) {
      out.push(round2(total - allocated));
    } else {
      const part = round2((total * pcts[i]) / sum);
      out.push(part);
      allocated = round2(allocated + part);
    }
  }
  return out;
}
