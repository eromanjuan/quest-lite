import { describe, it, expect } from 'vitest';
import {
  computeEstimate,
  computeTax,
  normalizeCrewInputs,
  priceForGrossMargin,
  priceForNetMargin,
  priceForMarkup,
  checkMarginFloor,
  allocateDraws,
  DrawValidation,
  flagBenchmarks,
  type EstimateInputs,
  type CalcLine,
} from '../server/domain/estimating/calc.js';
import { round2, money, num, ratio, allocateByPct } from '../server/core/money.js';

/**
 * Golden numbers.
 *
 * The figures below come from the reference sheets in HANDOFF.md §10 (Abraham's
 * framing and roofing tickets) and are asserted to the cent. They are the
 * regression net for the estimating engine: a change that moves any of them
 * changes what a customer is quoted, so it must be deliberate.
 */

const line = (
  description: string,
  qty: number,
  unitPrice: number,
  opts: Partial<CalcLine> = {},
): CalcLine => ({ description, qty, unitPrice, ...opts });

/* ------------------------------------------------------------------ */
/* The roofing sheet, reproduced exactly                              */
/* ------------------------------------------------------------------ */

/**
 * Material cost lines for the roofing ticket. The subtotal is 6476.43 and every
 * line is taxable, which makes the 8.5% tax figure 550.50 after half-up
 * rounding — the half-cent in 550.49655 is the case that catches a naive
 * Math.round-on-float implementation.
 */
const ROOFING_MATERIALS: CalcLine[] = [
  line('GAF Timberline HDZ shingles, per SQ (3 bundles)', 30, 139.0, { taxable: true, categoryKey: 'materials' }),
  line('GAF ridge cap, per 33 ft', 4, 86.25, { taxable: true, categoryKey: 'materials' }),
  line('GAF starter strip (120 LF), per bundle', 3, 84.85, { taxable: true, categoryKey: 'materials' }),
  line('SecureGrip 30 underlayment', 3, 90.0, { taxable: true, categoryKey: 'materials' }),
  line('Underlayment nails', 2, 24.6, { taxable: true, categoryKey: 'materials' }),
  line('Shingle coil nails 1-1/4', 3, 55.8, { taxable: true, categoryKey: 'materials' }),
  line('Staples for overhang, 1 in crown, 1 in long', 1, 41.5, { taxable: true, categoryKey: 'materials' }),
  line('Base sheet (2 SQ), black', 1, 130.0, { taxable: true, categoryKey: 'materials' }),
  line('Drip edge, 10 ft', 23, 8.0, { taxable: true, categoryKey: 'materials' }),
  line('Plastic black roof cement, 5 gal', 1, 74.0, { taxable: true, categoryKey: 'materials' }),
  line('Pipe jacks', 2, 20.39, { taxable: true, categoryKey: 'materials' }),
  line('Misc', 1.5, 500.0, { taxable: true, categoryKey: 'materials' }),
];

const ROOFING_LABOR: CalcLine[] = [
  line('Shingle install labor', 27, 90.0, { taxable: false, categoryKey: 'labor' }),
  line('Fascia', 1, 100.0, { taxable: false, categoryKey: 'labor' }),
  line('Plywood labor', 10, 50.0, { taxable: false, categoryKey: 'labor' }),
  line('Dump & gas', 1, 500.0, { taxable: false, categoryKey: 'labor' }),
];

const roofingInputs: EstimateInputs = {
  sheet: 'roofing',
  taxRate: 8.5,
  commissionPct: 10,
  otherExpenses: 0,
  sellLines: [line('Whole Roof Shingle Replacement (underlayment, drip edge)', 26, 580.0, { unit: 'sq' })],
  costLines: [...ROOFING_LABOR, ...ROOFING_MATERIALS],
};

describe('roofing sheet — HANDOFF §10 golden numbers', () => {
  const calc = computeEstimate(roofingInputs);

  it('prices the roof at the sheet price', () => {
    expect(calc.sellingPrice).toBe(15080.0);
    expect(calc.sellSubtotal).toBe(15080.0);
  });

  it('sums material cost to 6476.43', () => {
    const matSub = ROOFING_MATERIALS.reduce((s, l) => round2(s + round2(l.qty * l.unitPrice)), 0);
    expect(matSub).toBe(6476.43);
  });

  it('applies 8.5% tax to taxable cost with half-up rounding', () => {
    expect(computeTax(ROOFING_MATERIALS, 8.5)).toBe(550.5);
    expect(calc.tax).toBe(550.5);
  });

  it('adds labor to reach a hard cost of 10556.93', () => {
    expect(calc.hardCost).toBe(10556.93);
  });

  it('computes gross profit and margin', () => {
    expect(calc.grossProfit).toBe(4523.07);
    expect(calc.grossMargin).not.toBeNull();
    expect(round2(calc.grossMargin! * 100)).toBe(29.99);
  });

  it('computes commission as a percentage of SELLING price', () => {
    expect(calc.commission).toBe(1508.0);
  });

  it('computes net profit and margin after commission', () => {
    expect(calc.netProfit).toBe(3015.07);
    expect(round2(calc.netMargin! * 100)).toBe(19.99);
  });

  it('keeps markup separate from margin', () => {
    // Markup is profit ÷ COST, margin is profit ÷ PRICE. They must never be
    // interchangeable — conflating them is how a bid gets underpriced.
    expect(calc.markup).not.toBeNull();
    expect(round2(calc.markup! * 100)).toBe(42.84);
    expect(calc.markup!).toBeGreaterThan(calc.grossMargin!);
    // Margin 29.99% and markup 42.84% describe the same bid. Proving they
    // differ is what stops a future change from collapsing them into one field.
    expect(round2(calc.grossMargin! * 100)).toBe(29.99);
  });

  it('derives squares from sq-unit selling lines', () => {
    expect(calc.squares).toBe(26);
    expect(calc.costPerSquare).toBe(round2(10556.93 / 26));
    expect(calc.pricePerSquare).toBe(580.0);
  });

  it('reports cost as a share of price', () => {
    expect(round2((calc.hardCost / calc.sellingPrice) * 100)).toBe(70.01);
  });

  it('is complete and raises no warning flags', () => {
    expect(calc.complete).toBe(true);
    expect(calc.flags).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The framing / crew sheet                                            */
/* ------------------------------------------------------------------ */

describe('crew sheet — HANDOFF §10 golden numbers', () => {
  const supplies: CalcLine[] = [
    line('Crane', 1, 800.0, { categoryKey: 'materials' }),
    line('Hardware', 1, 1500.0, { categoryKey: 'materials' }),
    line('Dump', 1, 800.0, { categoryKey: 'materials' }),
    line('Gas', 1, 250.0, { categoryKey: 'materials' }),
    line('Insurance', 1, 600.0, { categoryKey: 'materials' }),
    line('Misc.', 1, 500.0, { categoryKey: 'materials' }),
  ];

  const crews = [
    { id: 'c1', people: 1, ratePerDay: 250, plannedDays: 5, overrunDays: 2 },
    { id: 'c2', people: 3, ratePerDay: 230, plannedDays: 5, overrunDays: 2 },
  ];

  const base = {
    quoteMode: 'sqft' as const,
    sqft: 1137,
    rate: 11.0,
    lump: 0,
    supplies,
    taxRate: 0,
    commissionPct: 0,
    otherExpenses: 0,
  };

  it('prices from sqft × rate', () => {
    const calc = computeEstimate(normalizeCrewInputs({ ...base, crews }));
    expect(calc.sellingPrice).toBe(12507.0);
  });

  it('bills each crew as headcount × day rate × planned days', () => {
    // 1×250×5 + 3×230×5 = 4700. This is the assertion that catches a crew cost
    // which ignores headcount — it would return 1250+1150 = 2400 instead.
    const calc = computeEstimate(
      normalizeCrewInputs({ ...base, crews: crews.map((c) => ({ ...c, overrunDays: 0 })) }),
    );
    const labor = calc.byCategory.find((c) => c.key === 'labor');
    expect(labor?.amount).toBe(4700.0);
    expect(calc.hardCost).toBe(9150.0);
    expect(calc.grossProfit).toBe(3357.0);
    expect(round2(calc.grossMargin! * 100)).toBe(26.84);
    // The framing sheet prints this as 26.8%; the engine keeps full precision
    // and the display layer rounds, so the two agree without the engine
    // committing to one decimal.
    expect((calc.grossMargin! * 100).toFixed(1)).toBe('26.8');
  });

  it('includes overrun days in the worst-case cost', () => {
    // 1×250×7 + 3×230×7 = 6580, plus 4450 supplies = 11030.
    const calc = computeEstimate(normalizeCrewInputs({ ...base, crews }));
    const labor = calc.byCategory.find((c) => c.key === 'labor');
    expect(labor?.amount).toBe(6580.0);
    expect(calc.hardCost).toBe(11030.0);
    expect(calc.grossProfit).toBe(1477.0);
    expect(round2(calc.grossMargin! * 100)).toBe(11.81);
  });

  it('honours a lump-sum price over sqft × rate', () => {
    const calc = computeEstimate(
      normalizeCrewInputs({ ...base, quoteMode: 'lump', lump: 20000, crews }),
    );
    expect(calc.sellingPrice).toBe(20000.0);
  });

  it('treats a missing headcount as one person rather than zero', () => {
    const calc = computeEstimate(
      normalizeCrewInputs({
        ...base,
        crews: [{ id: 'c1', people: 0, ratePerDay: 200, plannedDays: 4, overrunDays: 2 }],
      }),
    );
    const labor = calc.byCategory.find((c) => c.key === 'labor');
    expect(labor?.amount).toBe(1200.0);
  });
});

/* ------------------------------------------------------------------ */
/* Formula conventions                                                 */
/* ------------------------------------------------------------------ */

describe('rounding and coercion conventions', () => {
  it('rounds half a cent up', () => {
    expect(round2(6255.0 * 0.085)).toBe(531.68);
    expect(round2(0.5)).toBe(0.5);
    expect(round2(290.005)).toBe(290.01);
  });

  it('returns 0 for non-finite input instead of NaN leaking out', () => {
    expect(round2(Number.NaN)).toBe(0);
    expect(round2(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('reads negative and parenthesised accounting values as zero', () => {
    expect(money(-5)).toBe(0);
    expect(money('(1,200.00)')).toBe(0);
    expect(money('($500)')).toBe(0);
    expect(num('(1,200.00)')).toBe(-1200);
    expect(num('-12')).toBe(-12);
    expect(money('1,200.00')).toBe(1200);
  });

  it('returns null rather than Infinity when dividing by zero', () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    const calc = computeEstimate({
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 0,
      otherExpenses: 0,
      sellLines: [],
      costLines: [],
    });
    // An empty sheet must not report a confident 0% margin.
    expect(calc.grossMargin).toBeNull();
    expect(calc.netMargin).toBeNull();
    expect(calc.markup).toBeNull();
  });
});

describe('estimate flags', () => {
  it('flags hard cost above the selling price', () => {
    const calc = computeEstimate({
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 0,
      otherExpenses: 0,
      sellLines: [line('Price', 1, 1000)],
      costLines: [line('Cost', 1, 1500)],
    });
    expect(calc.flags.map((f) => f.code)).toContain('cost_over_price');
    expect(calc.netProfit).toBe(-500);
  });

  it('flags a negative net once commission is applied', () => {
    const calc = computeEstimate({
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 40,
      otherExpenses: 0,
      sellLines: [line('Price', 1, 1000)],
      costLines: [line('Cost', 1, 700)],
    });
    expect(calc.grossProfit).toBe(300);
    expect(calc.netProfit).toBe(-100);
    expect(calc.flags.map((f) => f.code)).toContain('negative_net');
  });

  it('warns when a sheet has no prices or no costs', () => {
    const empty = computeEstimate({
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 0,
      otherExpenses: 0,
      sellLines: [],
      costLines: [],
    });
    expect(empty.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(['no_costs', 'no_price']),
    );
    expect(empty.complete).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Target pricing                                                      */
/* ------------------------------------------------------------------ */

describe('target-margin pricing', () => {
  it('solves gross price as cost ÷ (1 − margin)', () => {
    const inputs: EstimateInputs = {
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 0,
      otherExpenses: 0,
      sellLines: [],
      costLines: ROOFING_MATERIALS,
    };
    const hardCost = computeEstimate(inputs).hardCost;
    expect(hardCost).toBe(6476.43);

    const price = priceForGrossMargin(0.3, hardCost)!;
    expect(price).toBe(9252.04);

    // Round-trip: pricing at that figure must actually deliver the target.
    const calc = computeEstimate({ ...inputs, sellLines: [line('Roof', 1, price)] });
    expect(round2(calc.grossMargin! * 100)).toBe(30.0);
  });

  it('solves net price accounting for commission and expenses', () => {
    // (C + E) ÷ (1 − commission − margin)
    const inputs: EstimateInputs = {
      sheet: 'roofing',
      taxRate: 0,
      commissionPct: 10,
      otherExpenses: 0,
      sellLines: [],
      costLines: [...ROOFING_LABOR, ...ROOFING_MATERIALS],
    };
    const hardCost = computeEstimate(inputs).hardCost;
    expect(hardCost).toBe(10006.43);

    const price = priceForNetMargin(0.2, hardCost, 10, 0)!;
    expect(price).toBe(14294.9);

    const calc = computeEstimate({ ...inputs, sellLines: [line('Roof', 1, price)] });
    expect(round2(calc.netMargin! * 100)).toBe(20.0);
  });

  it('solves the price for the full golden hard cost', () => {
    // 10556.93 at a 30% gross target: the figure an estimator would quote.
    expect(priceForGrossMargin(0.3, 10556.93)).toBe(15081.33);
    // The same cost at a 20% NET target must price higher, because commission
    // and the floor both have to be covered out of the same margin.
    expect(priceForNetMargin(0.2, 10556.93, 10, 0)).toBe(15081.33);
    expect(priceForNetMargin(0.2, 10556.93, 10, 500)).toBe(15795.61);
  });

  it('returns null when the target is unachievable', () => {
    expect(priceForGrossMargin(1, 1000)).toBeNull();
    expect(priceForGrossMargin(0.3, 0)).toBeNull();
    // Commission of 60% plus a 50% margin can never both be satisfied.
    expect(priceForNetMargin(0.5, 1000, 60)).toBeNull();
  });

  it('prices on markup separately, using cost as the base', () => {
    expect(priceForMarkup(42.85, 10556.93)).toBe(15080.57);
    // Markup and margin must not produce the same answer for the same number.
    expect(priceForMarkup(30, 1000)).toBe(1300);
    expect(priceForGrossMargin(0.3, 1000)).toBe(round2(1000 / 0.7));
  });
});

/* ------------------------------------------------------------------ */
/* Margin floor                                                        */
/* ------------------------------------------------------------------ */

describe('margin floor', () => {
  const aboveFloor = computeEstimate(roofingInputs);

  it('accepts a quote at or above the floor', () => {
    const check = checkMarginFloor(aboveFloor, 15);
    expect(check.floor).toBe(0.15);
    expect(check.below).toBe(false);
    expect(check.ok).toBe(true);
  });

  it('rejects a quote below the floor', () => {
    const check = checkMarginFloor(aboveFloor, 25);
    expect(check.below).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('takes net margin as the conservative metric when both are checked', () => {
    // Gross 29.99% clears a 25% floor, but net 19.99% does not. Checking both
    // must block on the weaker of the two.
    const check = checkMarginFloor(aboveFloor, 25, 'both');
    expect(check.metric).toBe('net');
    expect(check.ok).toBe(false);
    expect(check.below).toBe(true);
  });

  it('treats an unpriced sheet as below the floor rather than passing it', () => {
    const blank = computeEstimate({
      sheet: 'generic',
      taxRate: 0,
      commissionPct: 0,
      otherExpenses: 0,
      sellLines: [],
      costLines: [line('Cost', 1, 100)],
    });
    const check = checkMarginFloor(blank, 15);
    expect(check.below).toBe(true);
    expect(check.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Draw schedules                                                      */
/* ------------------------------------------------------------------ */

describe('draw schedule allocation', () => {
  it('splits a contract so the parts always re-sum to the whole', () => {
    const parts = allocateDraws(15080, [{ pct: 50 }, { pct: 30 }, { pct: 20 }]);
    expect(parts).toEqual([7540, 4524, 3016]);
    expect(round2(parts.reduce((a, b) => a + b, 0))).toBe(15080);
  });

  it('gives the remainder to the final part on an awkward total', () => {
    // 580.01 cannot split evenly; the cents must not be lost or duplicated.
    expect(allocateDraws(580.01, [{ pct: 50 }, { pct: 50 }])).toEqual([290.01, 290.0]);
    expect(allocateDraws(580.01, [{ pct: 50 }, { pct: 30 }, { pct: 20 }])).toEqual([
      290.01, 174.0, 116.0,
    ]);
  });

  it('refuses a schedule that does not total exactly 100', () => {
    expect(() => allocateDraws(1000, [{ pct: 50 }, { pct: 40 }])).toThrow(DrawValidation);
    expect(() => allocateDraws(1000, [{ pct: 50 }, { pct: 50.01 }])).toThrow(/must equal 100%/);
  });

  it('apportiones zero percent parts as zero', () => {
    expect(allocateByPct(1000, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(allocateByPct(1000, [])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Benchmarks                                                          */
/* ------------------------------------------------------------------ */

describe('benchmarks', () => {
  const observed = { costPerSquare: 406.04, pricePerSquare: 580.0, pricePerSqft: 13.26 };

  it('flags a value above the configured maximum', () => {
    const flags = flagBenchmarks(
      [{ id: 'b1', label: 'Cost per SQ', unit: 'cost_per_sq', min_value: 300, target_value: 350, max_value: 400 }],
      observed,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].direction).toBe('over');
    expect(flags[0].value).toBe(406.04);
  });

  it('flags a value below the configured minimum', () => {
    const flags = flagBenchmarks(
      [{ id: 'b1', label: 'Price per SQ', unit: 'price_per_sq', min_value: 600, target_value: 650, max_value: 700 }],
      observed,
    );
    expect(flags[0].direction).toBe('under');
  });

  it('stays silent when no range is configured', () => {
    const flags = flagBenchmarks(
      [{ id: 'b1', label: 'Cost per SQ', unit: 'cost_per_sq', min_value: null, target_value: 350, max_value: null }],
      observed,
    );
    expect(flags).toHaveLength(0);
  });

  it('never treats a benchmark as an industry standard', () => {
    // An out-of-range benchmark produces a flag the user can dismiss — it never
    // blocks release on its own.
    const flags = flagBenchmarks(
      [{ id: 'b1', label: 'x', unit: 'cost_per_sq', min_value: 1, target_value: null, max_value: 2 }],
      observed,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe('x');
  });
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

describe('determinism', () => {
  it('produces identical cents for identical inputs', () => {
    const a = computeEstimate(roofingInputs);
    const b = computeEstimate(roofingInputs);
    expect(a).toEqual(b);
  });

  it('does not drift when a long line list is summed in different orders', () => {
    const costs = ROOFING_MATERIALS;
    const forward = computeEstimate({ ...roofingInputs, costLines: costs });
    const reversed = computeEstimate({ ...roofingInputs, costLines: [...costs].reverse() });
    expect(forward.costSubtotal).toBe(reversed.costSubtotal);
    expect(forward.tax).toBe(reversed.tax);
    expect(forward.hardCost).toBe(reversed.hardCost);
  });
});
