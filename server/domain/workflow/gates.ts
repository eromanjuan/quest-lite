/**
 * Workflow gates.
 *
 * Every gate returns a list of blockers rather than throwing, so the UI can
 * render "why is this button disabled?" and the API can reject with the same
 * list. The API is authoritative — the UI only mirrors these results.
 *
 * Keep this file free of I/O: pure functions over record snapshots so they
 * are trivially unit-testable (tests/workflow-gates.test.ts).
 */

/* ------------------------------------------------------------------ */
/* Prospecting → Underwriting                                         */
/* ------------------------------------------------------------------ */

export interface QualificationInput {
  scopeSummary: string;
  projectAddress: string;
  contactPhone: string | null;
  contactEmail: string | null;
  isDecisionMaker: boolean;
  hasPlans: boolean;
  hasSiteVisit: boolean;
  /** When true, plans or a site visit is required before handoff. */
  requireEvidence: boolean;
}

export interface QualificationItem {
  key: string;
  label: string;
  met: boolean;
  required: boolean;
  hint: string;
}

export interface QualificationResult {
  ok: boolean;
  items: QualificationItem[];
  blockers: string[];
}

export function evaluateHandoffQualification(input: QualificationInput): QualificationResult {
  const contactable = Boolean(input.contactPhone || input.contactEmail);
  const evidence = input.hasPlans || input.hasSiteVisit;

  const items: QualificationItem[] = [
    {
      key: 'scope',
      label: 'Scope of work identified',
      met: input.scopeSummary.trim().length >= 10,
      required: true,
      hint: 'Describe the work to be priced in at least a sentence.',
    },
    {
      key: 'decision_maker',
      label: 'Decision-maker identified',
      met: input.isDecisionMaker,
      required: true,
      hint: 'Mark the contact as the decision-maker, or add a contact who is.',
    },
    {
      key: 'contact',
      label: 'Reachable contact detail',
      met: contactable,
      required: true,
      hint: 'A phone number or email is required.',
    },
    {
      key: 'address',
      label: 'Project address',
      met: input.projectAddress.trim().length >= 5,
      required: true,
      hint: 'Estimating needs the work location.',
    },
    {
      key: 'evidence',
      label: 'Plans attached or site visit booked',
      met: evidence,
      required: input.requireEvidence,
      hint: 'Attach a plan revision or book a site visit.',
    },
  ];

  const blockers = items.filter((i) => i.required && !i.met).map((i) => i.label);
  return { ok: blockers.length === 0, items, blockers };
}

/* ------------------------------------------------------------------ */
/* Quote release → Sales                                              */
/* ------------------------------------------------------------------ */

export interface ReleaseInput {
  sheetKind: string;
  hasSellLines: boolean;
  hasCostLines: boolean;
  pricingValid: boolean;          // no `bad` flags from the calc
  scopeComplete: boolean;         // every mandatory scope question answered
  missingScope: string[];
  scopeOfWorkText: string;
  exclusionsText: string;
  takeoffRequired: boolean;
  takeoffItemCount: number;
  takeoffReviewed: boolean;
  marginFloor: number;            // percent
  grossMarginPct: number | null;  // percent, null when unknown
  netMarginPct: number | null;
  approvedException: boolean;
  pendingApprovals: number;
}

export interface GateResult {
  ok: boolean;
  blockers: Array<{ key: string; label: string; detail?: string }>;
}

export function evaluateQuoteRelease(input: ReleaseInput): GateResult {
  const blockers: GateResult['blockers'] = [];

  if (!input.hasSellLines)
    blockers.push({ key: 'price', label: 'Selling price lines are missing' });
  if (!input.hasCostLines)
    blockers.push({ key: 'cost', label: 'Cost lines are missing' });
  if (!input.pricingValid)
    blockers.push({
      key: 'pricing_valid',
      label: 'Pricing is not valid',
      detail: 'Hard cost exceeds the selling price, or net profit is negative.',
    });
  if (!input.scopeComplete)
    blockers.push({
      key: 'scope',
      label: 'Mandatory scope questions are unanswered',
      detail: input.missingScope.join(', '),
    });
  if (input.scopeOfWorkText.trim().length < 20)
    blockers.push({ key: 'sow', label: 'Scope of work text is too short to send' });
  if (input.exclusionsText.trim().length < 5)
    blockers.push({ key: 'exclusions', label: 'Exclusions have not been written' });
  if (input.takeoffRequired && input.takeoffItemCount === 0)
    blockers.push({ key: 'takeoff', label: 'Takeoff quantities are required for this bid' });
  if (input.takeoffRequired && !input.takeoffReviewed)
    blockers.push({ key: 'takeoff_review', label: 'Takeoff has not been marked reviewed' });

  const marginPct = input.netMarginPct ?? input.grossMarginPct;
  const belowFloor =
    marginPct !== null && input.marginFloor > 0 && marginPct < input.marginFloor;
  if (belowFloor && !input.approvedException)
    blockers.push({
      key: 'margin_floor',
      label: `Margin is below the ${input.marginFloor}% floor`,
      detail: `Actual ${marginPct.toFixed(1)}% — request a margin exception or adjust pricing.`,
    });

  if (input.pendingApprovals > 0)
    blockers.push({
      key: 'pending_approval',
      label: `${input.pendingApprovals} approval(s) are still pending`,
    });

  return { ok: blockers.length === 0, blockers };
}

/* ------------------------------------------------------------------ */
/* Sales → Won                                                        */
/* ------------------------------------------------------------------ */

export interface WonGateConfig {
  require_contract_signed: number;
  require_deposit: number;
  require_insurance: number;
  require_compliance: number;
  require_approval: number;
}

export interface WonGateFacts {
  hasSignedContract: boolean;
  depositStatus: string;        // not_required | due | received | cleared
  complianceItems: Array<{ key: string; name: string; required: number; received: number }>;
  pendingInternalApprovals: number;
  hasReleasedQuote: boolean;
}

export interface WonGateResult {
  ok: boolean;
  config: WonGateConfig;
  checks: Array<{ key: string; label: string; passed: boolean; required: boolean; detail?: string }>;
}

export function evaluateWonGate(config: WonGateConfig, facts: WonGateFacts): WonGateResult {
  const checks: WonGateResult['checks'] = [];

  checks.push({
    key: 'quote',
    label: 'Released quote exists',
    passed: facts.hasReleasedQuote,
    required: true,
  });

  checks.push({
    key: 'contract',
    label: 'Contract signed',
    passed: !config.require_contract_signed || facts.hasSignedContract,
    required: Boolean(config.require_contract_signed),
    detail: facts.hasSignedContract ? undefined : 'No signed contract on record.',
  });

  const depositOk =
    !config.require_deposit ||
    facts.depositStatus === 'cleared' ||
    facts.depositStatus === 'not_required';
  checks.push({
    key: 'deposit',
    label: 'Deposit cleared',
    passed: depositOk,
    required: Boolean(config.require_deposit),
    detail: depositOk ? undefined : `Deposit status: ${facts.depositStatus}.`,
  });

  const insurance = facts.complianceItems.filter((i) => i.key === 'insurance');
  const insuranceOk =
    !config.require_insurance ||
    (insurance.length > 0 && insurance.every((i) => i.received === 1));
  checks.push({
    key: 'insurance',
    label: 'Insurance received',
    passed: insuranceOk,
    required: Boolean(config.require_insurance),
  });

  const otherCompliance = facts.complianceItems.filter((i) => i.key !== 'insurance');
  const complianceOk =
    !config.require_compliance ||
    otherCompliance.filter((i) => i.required === 1).every((i) => i.received === 1);
  checks.push({
    key: 'compliance',
    label: 'Required compliance documents received',
    passed: complianceOk,
    required: Boolean(config.require_compliance),
  });

  const approvalOk =
    !config.require_approval || facts.pendingInternalApprovals === 0;
  checks.push({
    key: 'approval',
    label: 'Internal approvals complete',
    passed: approvalOk,
    required: Boolean(config.require_approval),
    detail: approvalOk ? undefined : `${facts.pendingInternalApprovals} pending approval(s).`,
  });

  return { ok: checks.every((c) => !c.required || c.passed), config, checks };
}

/* ------------------------------------------------------------------ */
/* Production job pipeline                                            */
/* ------------------------------------------------------------------ */

export const JOB_STAGES = [
  'unscheduled',
  'scheduled',
  'in_progress',
  'punch_list',
  'complete',
  'invoiced',
  'paid',
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

const JOB_TRANSITIONS: Record<JobStage, JobStage[]> = {
  unscheduled: ['scheduled'],
  scheduled: ['in_progress', 'unscheduled'],
  in_progress: ['punch_list', 'scheduled'],
  punch_list: ['complete', 'in_progress'],
  complete: ['invoiced', 'punch_list'],
  invoiced: ['paid', 'complete'],
  paid: [],
};

export function canTransitionJob(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = JOB_TRANSITIONS[from as JobStage];
  if (!allowed) return false;
  return allowed.includes(to as JobStage);
}

export interface JobAdvanceInput {
  from: string;
  to: string;
  stageEnteredAt: number;
  now: number;
  hasSchedule: boolean;
  hasCrewOrForeman: boolean;
  hasDailyReportToday: boolean;
  hasSubmittedReports: number;
  openBlockers: number;
  openTasks: number;
  hasInvoice: boolean;
  outstandingBalance: number;
  completionAuthorized: boolean;
}

export function evaluateJobAdvance(input: JobAdvanceInput): GateResult {
  const blockers: GateResult['blockers'] = [];

  if (!canTransitionJob(input.from, input.to)) {
    blockers.push({
      key: 'transition',
      label: `A job cannot move from "${input.from}" to "${input.to}"`,
    });
    return { ok: false, blockers };
  }

  if (input.to === 'scheduled' && !input.hasSchedule)
    blockers.push({ key: 'schedule', label: 'A start date is required to schedule the job' });

  if (input.to === 'in_progress' && !input.hasCrewOrForeman)
    blockers.push({ key: 'crew', label: 'Assign a crew or foreman before starting work' });

  if (input.to === 'complete') {
    if (input.hasSubmittedReports === 0)
      blockers.push({ key: 'reports', label: 'No daily reports have been submitted for this job' });
    if (input.openBlockers > 0)
      blockers.push({
        key: 'blockers',
        label: `${input.openBlockers} blocker(s) are still open`,
      });
    if (input.openTasks > 0)
      blockers.push({
        key: 'tasks',
        label: `${input.openTasks} task(s) are still open (punch list or closeout)`,
      });
    if (!input.completionAuthorized)
      blockers.push({
        key: 'authorized',
        label: 'Completion has not been authorized by a project manager',
      });
  }

  if (input.to === 'paid' && input.outstandingBalance > 0.004)
    blockers.push({
      key: 'balance',
      label: `Outstanding balance of ${input.outstandingBalance.toFixed(2)} must be collected first`,
      detail: 'Record a payment or apply an authorized exception.',
    });

  return { ok: blockers.length === 0, blockers };
}

/* ------------------------------------------------------------------ */
/* Change orders                                                      */
/* ------------------------------------------------------------------ */

export const CHANGE_ORDER_STATUSES = [
  'requested',
  'priced',
  'internal_approved',
  'customer_presented',
  'customer_approved',
  'customer_rejected',
  'authorized',
  'void',
] as const;

export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

const CO_TRANSITIONS: Record<string, ChangeOrderStatus[]> = {
  requested: ['priced', 'void'],
  priced: ['internal_approved', 'requested', 'void'],
  internal_approved: ['customer_presented', 'priced', 'void'],
  customer_presented: ['customer_approved', 'customer_rejected', 'priced', 'void'],
  customer_approved: ['authorized', 'customer_presented', 'void'],
  customer_rejected: ['void'],
  authorized: [],
  void: [],
};

export function canTransitionChangeOrder(from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = CO_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to as ChangeOrderStatus);
}

export interface ChangeOrderAdvanceInput {
  from: string;
  to: string;
  internalAmount: number | null;
  customerAmount: number | null;
  hasScope: boolean;
  pricedByUnderwriting: boolean;
  internallyApproved: boolean;
  customerApproved: boolean;
}

/**
 * Pricing a change order or authorizing it are controlled steps: creating a
 * request never authorizes work, and authorizing requires the customer to
 * have approved first.
 */
export function evaluateChangeOrderAdvance(input: ChangeOrderAdvanceInput): GateResult {
  const blockers: GateResult['blockers'] = [];

  if (!canTransitionChangeOrder(input.from, input.to)) {
    blockers.push({
      key: 'transition',
      label: `A change order cannot move from "${input.from}" to "${input.to}"`,
    });
    return { ok: false, blockers };
  }

  if (input.to === 'priced') {
    if (input.internalAmount === null || input.internalAmount <= 0)
      blockers.push({ key: 'cost', label: 'Internal cost must be priced first' });
    if (input.customerAmount === null || input.customerAmount <= 0)
      blockers.push({ key: 'price', label: 'Customer price must be set' });
    if (!input.hasScope) blockers.push({ key: 'scope', label: 'Describe the changed scope' });
  }

  if (input.to === 'internal_approved' && !input.pricedByUnderwriting)
    blockers.push({ key: 'priced', label: 'Underwriting must price the change first' });

  if (input.to === 'customer_presented' && !input.internallyApproved)
    blockers.push({ key: 'internal', label: 'Internal approval is required before presenting' });

  if (input.to === 'customer_approved' && !input.customerApproved)
    blockers.push({ key: 'customer', label: 'The customer has not approved this change' });

  if (input.to === 'authorized') {
    if (!input.customerApproved)
      blockers.push({
        key: 'customer',
        label: 'Production cannot be authorized before the customer approves',
      });
    if (!input.internallyApproved)
      blockers.push({ key: 'internal', label: 'Internal approval is missing' });
  }

  return { ok: blockers.length === 0, blockers };
}
