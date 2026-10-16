/**
 * Role → permission matrix.
 *
 * This is the single source of truth for authorization. Routes check
 * permissions server-side; the UI only mirrors them for ergonomics.
 * Hiding a button is never the control — every mutating route re-checks.
 */

export const ROLES = {
  owner: {
    name: 'Owner / Administrator',
    description: 'Full financial, operational and administrative access.',
  },
  rep: {
    name: 'Prospecting Representative',
    description: 'Lead generation, follow-ups and qualification. No pricing access.',
  },
  estimator: {
    name: 'Estimator',
    description: 'Bid intake, takeoff, underwriting sheets, quotes and margin control.',
  },
  closer: {
    name: 'Sales Closer',
    description: 'Proposal presentation, negotiation, contracts and deposits. Cannot alter approved pricing.',
  },
  pm: {
    name: 'Project Manager',
    description: 'Scheduling, production, costs, change orders and collections.',
  },
  foreman: {
    name: 'Foreman',
    description: 'Field scope, schedule, crew, tasks, daily reports and photos. No margin or profit visibility.',
  },
} as const;

export type RoleKey = keyof typeof ROLES;

export const PERMISSIONS = {
  'admin.manage': 'Manage users, roles and system configuration',
  'audit.view': 'View the audit trail',
  'settings.manage': 'Change margin floors, gates, benchmarks and workflow rules',

  'crm.read': 'View companies, contacts and opportunities',
  'crm.write': 'Create and edit companies, contacts and opportunities',

  'prospect.read': 'View the prospecting pipeline',
  'prospect.write': 'Create and move prospects, edit dispositions and temperature',
  'prospect.handoff': 'Send a qualified prospect to Underwriting',

  'task.read': 'View tasks and the follow-up calendar',
  'task.write': 'Create, complete and reassign tasks',

  'comms.log': 'Log calls, texts, emails and notes',
  'comms.send': 'Send messages through a configured live provider',
  'template.manage': 'Manage communication templates and drip campaigns',

  'bid.read': 'View the bid queue and estimating data',
  'bid.write': 'Create bids, run scope intake, takeoff and underwriting sheets',
  'estimate.read': 'View underwriting sheets, calculations and released quotes',
  'estimate.write': 'Create and edit underwriting sheets and estimates',
  'estimate.release': 'Release a quote to Sales',

  'pricebook.read': 'View the vendor price book',
  'pricebook.write': 'Add and edit unprotected price book items',
  'pricebook.protected_write': 'Change protected vendor prices',

  'margin.request_exception': 'Request a margin-floor exception',
  'margin.approve_exception': 'Approve or reject margin-floor exceptions',

  'deal.read': 'View the deal pipeline',
  'deal.write': 'Move deals, build proposals, draw schedules and contracts',
  'deal.request_repricing': 'Send a quote back to Underwriting for re-pricing',
  'deal.mark_won': 'Mark a deal Won once its gate requirements are satisfied',

  'production.read': 'View projects, jobs, schedules and field records',
  'production.write': 'Manage jobs, crews, daily reports and field tasks',
  'production.financials': 'View project profit, margin and cost performance',
  'production.log_cost': 'Record committed and actual job costs',

  'changeorder.request': 'Raise a change-order request',
  'changeorder.price': 'Price a change order in Underwriting',
  'changeorder.approve_internal': 'Approve change-order pricing internally',
  'changeorder.present': 'Present a change order to the customer',
  'changeorder.authorize': 'Authorize a change order for production',

  'invoice.manage': 'Create invoices, record draws and payments',
  'kpi.view': 'View company-wide dashboards and KPI reporting',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

const READ_ONLY_CORE: PermissionKey[] = [
  'crm.read',
  'prospect.read',
  'task.read',
  'bid.read',
  'estimate.read',
  'pricebook.read',
  'deal.read',
  'production.read',
  'comms.log',
  'kpi.view',
];

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  owner: ALL,

  rep: [
    ...READ_ONLY_CORE,
    'crm.write',
    'prospect.write',
    'prospect.handoff',
    'task.write',
    'comms.send',
    'template.manage',
  ],

  estimator: [
    ...READ_ONLY_CORE,
    'crm.write',
    'prospect.write',
    'task.write',
    'bid.write',
    'estimate.write',
    'estimate.release',
    'pricebook.write',
    'pricebook.protected_write',
    'margin.request_exception',
    'changeorder.price',
    'changeorder.approve_internal',
    'deal.request_repricing',
    'template.manage',
  ],

  closer: [
    ...READ_ONLY_CORE,
    'crm.write',
    'prospect.write',
    'task.write',
    'deal.write',
    'deal.request_repricing',
    'deal.mark_won',
    'changeorder.present',
    'comms.send',
    'template.manage',
  ],

  pm: [
    ...READ_ONLY_CORE,
    'crm.write',
    'task.write',
    'production.write',
    'production.financials',
    'production.log_cost',
    'changeorder.request',
    'changeorder.approve_internal',
    'invoice.manage',
    'estimate.read',
    'deal.read',
  ],

  foreman: [
    'crm.read',
    'task.read',
    'task.write',
    'production.read',
    'production.write',
    'changeorder.request',
    'comms.log',
    // Deliberately absent: production.financials, estimate.*, pricebook.*,
    // deal.*, invoice.manage, kpi.view — a foreman must not see margin/profit.
  ],
};

const cache = new Map<RoleKey, Set<PermissionKey>>();

export function permissionsFor(role: string | null | undefined): Set<PermissionKey> {
  if (!role || !(role in ROLE_PERMISSIONS)) return new Set();
  const key = role as RoleKey;
  let set = cache.get(key);
  if (!set) {
    set = new Set(ROLE_PERMISSIONS[key]);
    cache.set(key, set);
  }
  return set;
}

export function can(role: string | null | undefined, permission: PermissionKey): boolean {
  return permissionsFor(role).has(permission);
}

export function isRole(value: string | null | undefined): value is RoleKey {
  return typeof value === 'string' && value in ROLE_PERMISSIONS;
}
