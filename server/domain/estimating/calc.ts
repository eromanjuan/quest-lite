import { round2, num, ratio, allocateByPct } from '../../core/money.js';

/**
 * Estimating engine.
 *
 * One engine serves every trade. Sheets differ only in HOW inputs are
 * normalised into two lists — selling lines and cost lines — plus the
 * tax / commission / expense rates. All money passes through round2 so the
 * same inputs always produce the same cents (see tests/estimating.test.ts).
 *
 * Definitions (these are the contract the UI, the API and the tests share):
 *
 *   hardCost      = sum(cost lines) + tax on taxable cost buckets
 *   sellingPrice  = sum(selling lines), unless a target-margin price is applied
 *   grossProfit   = sellingPrice - hardCost
 *   grossMargin   = grossProfit / sellingPrice          (null when price = 0)
 *   commission    = sellingPrice * commissionPct / 100
 *   netProfit     = sellingPrice - hardCost - commission - otherExpenses
 *   netMargin     = netProfit / sellingPrice            (null when price = 0)
 *   markup        = grossProfit / hardCost              (NOT the same as margin)
 */

export type SheetKind = 'roofing' | 'crew' | 'generic';

export interface CalcLine {
  id?: string;
  code?: string;
  description: string;
  qty: number;
  unit?: string;
  unitPrice: number;
  categoryId?: string | null;
  categoryKey?: string | null;
  taxable?: boolean;
}

export interface CrewLine {
  id?: string;
  name?: string;
  people: number;
  ratePerDay: number;
  plannedDays: number;
  overrunDays?: number;
}

export interface EstimateInputs {
  sheet: SheetKind;
  taxRate: number;
  commissionPct: number;
  otherExpenses: number;
  sellLines: CalcLine[];
  costLines: CalcLine[];
  /** Optional measurement area for $/sqft reporting (roof area or building area). */
  areaSqft?: number;
}

export interface CategoryTotal {
  key: string;
  name: string;
  amount: number;
  tax: number;
}

export interface CalcFlag {
  level: 'bad' | 'warn';
  code: string;
  message: string;
}

export interface EstimateCalc {
  sellSubtotal: number;
  costSubtotal: number;
  tax: number;
  hardCost: number;
  sellingPrice: number;
  grossProfit: number;
  grossMargin: number | null;
  commission: number;
  otherExpenses: number;
  netProfit: number;
  netMargin: number | null;
  markup: number | null;
  squares: number;
  areaSqft: number;
  costPerSquare: number | null;
  pricePerSquare: number | null;
  pricePerSqft: number | null;
  byCategory: CategoryTotal[];
  complete: boolean;
  flags: CalcFlag[];
}

const money = (v: unknown) => {
  const n = num(v);
  return n < 0 ? 0 : n;
};

function lineAmount(l: CalcLine): number {
  return round2(money(l.qty) * money(l.unitPrice));
}

/** Taxable cost buckets (materials by default) carry sales/use tax into hard cost. */
export function computeTax(costLines: CalcLine[], taxRate: number): number {
  const taxable = costLines
    .filter((l) => l.taxable)
    .reduce((sum, l) => round2(sum + lineAmount(l)), 0);
  return round2((taxable * money(taxRate)) / 100);
}

export function computeEstimate(inputs: EstimateInputs): EstimateCalc {
  const sellLines = inputs.sellLines ?? [];
  const costLines = inputs.costLines ?? [];
  const taxRate = money(inputs.taxRate);
  const commissionPct = money(inputs.commissionPct);
  const otherExpenses = money(inputs.otherExpenses);

  const sellSubtotal = round2(
    sellLines.reduce((sum, l) => round2(sum + lineAmount(l)), 0),
  );
  const costSubtotal = round2(
    costLines.reduce((sum, l) => round2(sum + lineAmount(l)), 0),
  );
  const tax = computeTax(costLines, taxRate);
  const hardCost = round2(costSubtotal + tax);
  const sellingPrice = sellSubtotal;

  const grossProfit = round2(sellingPrice - hardCost);
  const grossMargin = ratio(grossProfit, sellingPrice);
  const commission = round2((sellingPrice * commissionPct) / 100);
  const netProfit = round2(sellingPrice - hardCost - commission - otherExpenses);
  const netMargin = ratio(netProfit, sellingPrice);
  const markup = ratio(grossProfit, hardCost);

  const byCategory = totalByCategory(costLines, taxRate);
  const { squares, areaSqft } = measure(sellLines, inputs.areaSqft);

  const flags: CalcFlag[] = [];
  if (sellingPrice > 0 && hardCost > sellingPrice) {
    flags.push({
      level: 'bad',
      code: 'cost_over_price',
      message: 'Hard cost exceeds the selling price.',
    });
  }
  if (sellingPrice > 0 && netProfit < 0) {
    flags.push({
      level: 'bad',
      code: 'negative_net',
      message: 'Net profit is negative after commission and expenses.',
    });
  }
  if (costLines.length === 0) {
    flags.push({
      level: 'warn',
      code: 'no_costs',
      message: 'No cost lines have been entered yet.',
    });
  }
  if (sellLines.length === 0) {
    flags.push({
      level: 'warn',
      code: 'no_price',
      message: 'No selling lines have been entered yet.',
    });
  }

  return {
    sellSubtotal,
    costSubtotal,
    tax,
    hardCost,
    sellingPrice,
    grossProfit,
    grossMargin,
    commission,
    otherExpenses,
    netProfit,
    netMargin,
    markup,
    squares,
    areaSqft,
    costPerSquare: squares > 0 ? round2(hardCost / squares) : null,
    pricePerSquare: squares > 0 ? round2(sellingPrice / squares) : null,
    pricePerSqft: areaSqft > 0 ? round2(sellingPrice / areaSqft) : null,
    byCategory,
    complete: sellLines.length > 0 && costLines.length > 0,
    flags,
  };
}

function totalByCategory(costLines: CalcLine[], taxRate: number): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>();
  for (const l of costLines) {
    const key = l.categoryKey ?? l.categoryId ?? 'other';
    const entry = map.get(key) ?? { key, name: l.description ? '' : key, amount: 0, tax: 0 };
    entry.amount = round2(entry.amount + lineAmount(l));
    if (l.taxable) entry.tax = round2((entry.amount * taxRate) / 100);
    map.set(key, entry);
  }
  return [...map.values()];
}

/** Roofing squares come from sell/labor lines whose unit is `sq`. */
function measure(sellLines: CalcLine[], areaSqft?: number) {
  const squares = round2(
    sellLines
      .filter((l) => (l.unit ?? '').toLowerCase() === 'sq')
      .reduce((sum, l) => round2(sum + money(l.qty)), 0),
  );
  const area = money(areaSqft) || round2(squares * 100);
  return { squares, areaSqft: area };
}

/* ------------------------------------------------------------------ */
/* Target-margin pricing                                               */
/* ------------------------------------------------------------------ */

/**
 * Selling price that yields `targetMargin` (0–1 decimal) on gross profit:
 *   (P - C) / P = M   =>   P = C / (1 - M)
 * Returns null when the target is not achievable (M >= 1).
 */
export function priceForGrossMargin(targetMargin: number, hardCost: number): number | null {
  const m = num(targetMargin);
  if (m >= 1) return null;
  const c = money(hardCost);
  if (c <= 0) return null;
  return round2(c / (1 - m));
}

/**
 * Selling price that yields `targetMargin` after commission and other
 * expenses:  (P - C - c*P - E) / P = M  =>  P = (C + E) / (1 - c - M)
 * where `commissionPct` is a percentage (10 for 10%).
 */
export function priceForNetMargin(
  targetMargin: number,
  hardCost: number,
  commissionPct: number,
  otherExpenses = 0,
): number | null {
  const m = num(targetMargin);
  const c = money(commissionPct) / 100;
  const denom = 1 - c - m;
  if (denom <= 0) return null;
  const cost = money(hardCost) + money(otherExpenses);
  if (cost <= 0) return null;
  return round2(cost / denom);
}

/** Markup is profit ÷ COST. Kept separate so it can never be mistaken for margin. */
export function priceForMarkup(markupPct: number, hardCost: number): number {
  return round2(money(hardCost) * (1 + money(markupPct) / 100));
}

/* ------------------------------------------------------------------ */
/* Sheet normalisers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Framing / crew sheet: the client price comes from a sqft × rate or a lump
 * sum; costs come from crew days plus a supply list.
 */
export function normalizeCrewInputs(opts: {
  quoteMode: 'sqft' | 'lump';
  sqft: number;
  rate: number;
  lump: number;
  crews: CrewLine[];
  supplies: CalcLine[];
  taxRate: number;
  commissionPct: number;
  otherExpenses: number;
  includeOverrun?: boolean;
}): EstimateInputs {
  const includeOverrun = opts.includeOverrun !== false;
  const price =
    opts.quoteMode === 'lump'
      ? round2(money(opts.lump))
      : round2(money(opts.sqft) * money(opts.rate));

  const costLines: CalcLine[] = [];
  for (const [i, c] of (opts.crews ?? []).entries()) {
    const people = money(c.people) || 1;
    const days = money(c.plannedDays) + (includeOverrun ? money(c.overrunDays ?? 0) : 0);
    // A crew bills as headcount × day rate × days. The unit price stored on the
    // line is the crew day rate (headcount folded in) so the line amount is
    // people × rate × days and the quantity stays readable as days on site.
    costLines.push({
      id: c.id ?? `crew-${i}`,
      description: c.name ?? `Crew ${i + 1}`,
      qty: days,
      unit: 'day',
      unitPrice: round2(money(c.ratePerDay) * people),
      categoryKey: 'labor',
      taxable: false,
      code: undefined,
    });
  }
  for (const s of opts.supplies ?? []) {
    costLines.push({ ...s, categoryKey: s.categoryKey ?? 'materials' });
  }

  const sellLines: CalcLine[] =
    price > 0
      ? [{ description: 'Contract sum', qty: 1, unit: 'ls', unitPrice: price }]
      : [];

  return {
    sheet: 'crew',
    taxRate: money(opts.taxRate),
    commissionPct: money(opts.commissionPct),
    otherExpenses: money(opts.otherExpenses),
    sellLines,
    costLines,
    areaSqft: money(opts.sqft),
  };
}

/* ------------------------------------------------------------------ */
/* Margin floor                                                        */
/* ------------------------------------------------------------------ */

export interface MarginCheck {
  ok: boolean;
  metric: 'gross' | 'net';
  actual: number | null;
  floor: number;
  below: boolean;
}

/**
 * `floor` is a percentage (15 for 15%). The net margin is the conservative
 * metric when commission is configured, so it is checked in addition to gross.
 */
export function checkMarginFloor(
  calc: EstimateCalc,
  floorPct: number,
  metric: 'gross' | 'net' | 'both' = 'both',
): MarginCheck {
  const floor = money(floorPct) / 100;
  const gross = calc.grossMargin;
  const net = calc.netMargin;
  const actual = metric === 'net' ? net : gross;
  const belowGross = metric !== 'net' && gross !== null && gross < floor;
  const belowNet = metric !== 'gross' && net !== null && net < floor;
  const incomplete = calc.sellingPrice <= 0;
  return {
    ok: incomplete ? false : !belowGross && !belowNet,
    metric: metric === 'both' ? 'net' : metric,
    actual: actual ?? null,
    floor,
    below: incomplete ? true : belowGross || belowNet,
  };
}

/* ------------------------------------------------------------------ */
/* Benchmarks                                                          */
/* ------------------------------------------------------------------ */

export interface Benchmark {
  id: string;
  label: string;
  unit: string;
  min_value: number | null;
  target_value: number | null;
  max_value: number | null;
}

export interface BenchmarkFlag {
  benchmarkId: string;
  label: string;
  unit: string;
  value: number;
  min: number | null;
  max: number | null;
  direction: 'under' | 'over';
}

/**
 * Compares an observed unit cost against a configured benchmark range.
 * Benchmarks are administrator data — they are never presented as industry
 * standards, and no flag is raised when a benchmark has no range configured.
 */
export function flagBenchmarks(
  benchmarks: Benchmark[],
  observed: { costPerSquare?: number | null; pricePerSquare?: number | null; pricePerSqft?: number | null },
): BenchmarkFlag[] {
  const out: BenchmarkFlag[] = [];
  for (const b of benchmarks) {
    let value: number | null = null;
    if (b.unit === 'cost_per_sq') value = observed.costPerSquare ?? null;
    else if (b.unit === 'price_per_sq') value = observed.pricePerSquare ?? null;
    else if (b.unit === 'price_per_sqft') value = observed.pricePerSqft ?? null;
    if (value === null || !Number.isFinite(value)) continue;
    if (b.max_value !== null && value > b.max_value) {
      out.push({ benchmarkId: b.id, label: b.label, unit: b.unit, value, min: b.min_value, max: b.max_value, direction: 'over' });
    } else if (b.min_value !== null && value < b.min_value) {
      out.push({ benchmarkId: b.id, label: b.label, unit: b.unit, value, min: b.min_value, max: b.max_value, direction: 'under' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payment / draw schedules                                            */
/* ------------------------------------------------------------------ */

export interface DrawInput {
  pct: number;
}

/**
 * Allocates `contractValue` across draw percentages, guaranteeing the parts
 * sum to exactly the contract value. Throws on a non-100% total so a broken
 * schedule can never be persisted.
 */
export function allocateDraws(contractValue: number, items: DrawInput[]): number[] {
  const pctSum = round2(items.reduce((s, i) => s + money(i.pct), 0));
  if (Math.abs(pctSum - 100) > 0.005) {
    throw new DrawValidation(
      `Draw percentages total ${pctSum}%, which must equal 100%.`,
      { pctSum },
    );
  }
  return allocateByPct(money(contractValue), items.map((i) => money(i.pct)));
}

export class DrawValidation extends Error {
  details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'DrawValidation';
    this.details = details;
  }
}
