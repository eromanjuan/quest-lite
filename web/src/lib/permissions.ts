/**
 * Mirrors the server-side permission keys.
 *
 * The SERVER is authoritative — these exist only so the UI can disable or
 * hide controls the user cannot use. Every route re-checks on its own.
 */

export type PermissionKey =
  | 'admin.manage'
  | 'audit.view'
  | 'settings.manage'
  | 'crm.read'
  | 'crm.write'
  | 'prospect.read'
  | 'prospect.write'
  | 'prospect.handoff'
  | 'task.read'
  | 'task.write'
  | 'comms.log'
  | 'comms.send'
  | 'template.manage'
  | 'bid.read'
  | 'bid.write'
  | 'estimate.read'
  | 'estimate.write'
  | 'estimate.release'
  | 'pricebook.read'
  | 'pricebook.write'
  | 'pricebook.protected_write'
  | 'margin.request_exception'
  | 'margin.approve_exception'
  | 'deal.read'
  | 'deal.write'
  | 'deal.request_repricing'
  | 'deal.mark_won'
  | 'production.read'
  | 'production.write'
  | 'production.financials'
  | 'production.log_cost'
  | 'changeorder.request'
  | 'changeorder.price'
  | 'changeorder.approve_internal'
  | 'changeorder.present'
  | 'changeorder.authorize'
  | 'invoice.manage'
  | 'kpi.view';

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner / Administrator',
  rep: 'Prospecting Rep',
  estimator: 'Estimator',
  closer: 'Sales Closer',
  pm: 'Project Manager',
  foreman: 'Foreman',
};
