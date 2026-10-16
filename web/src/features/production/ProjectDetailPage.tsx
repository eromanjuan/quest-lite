import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { del, post, qs, ApiError } from '../../lib/api';
import { useFetch } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import type { PermissionKey } from '../../lib/permissions';
import {
  Badge,
  BlockerList,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormActions,
  Input,
  LinkButton,
  Loading,
  Meter,
  Modal,
  PageHead,
  Select,
  Stat,
  Tabs,
  TextArea,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  dateShort,
  fromLocalInputValue,
  money,
  pct,
  stageLabel,
  titleCase,
  TRADE_LABELS,
} from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Types and constants                                                 */
/* ------------------------------------------------------------------ */

interface ProjectDetailData {
  project: any;
  jobs: any[];
  draws: any[];
  invoices: any[];
  changeOrders: any[];
  recentReports: any[];
  openTasks: any[];
  financials: any | null;
  financialsRestricted?: boolean;
}

const PROJECT_TONE: Record<string, Tone> = {
  active: 'green',
  complete: 'blue',
  invoiced: 'violet',
  closed: 'neutral',
  cancelled: 'red',
};

const JOB_STAGE_TONE: Record<string, Tone> = {
  unscheduled: 'neutral',
  scheduled: 'blue',
  in_progress: 'green',
  punch_list: 'amber',
  complete: 'violet',
  invoiced: 'blue',
  paid: 'accent',
};

const CO_TONE: Record<string, Tone> = {
  requested: 'neutral',
  priced: 'blue',
  internal_approved: 'violet',
  customer_presented: 'amber',
  customer_approved: 'green',
  customer_rejected: 'red',
  authorized: 'green',
  void: 'outline',
};

const INVOICE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  sent: 'blue',
  partial: 'amber',
  paid: 'green',
  void: 'outline',
};

const REPORT_TONE: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'blue',
  approved: 'green',
};

const CO_LABEL: Record<string, string> = {
  priced: 'Price change order',
  internal_approved: 'Approve internally',
  customer_presented: 'Present to customer',
  customer_approved: 'Record customer approval',
  customer_rejected: 'Record customer rejection',
  authorized: 'Authorize work',
  void: 'Void change order',
};

/** Mirrors CO_PERMISSIONS in server/routes/production.ts — the server re-checks. */
const CO_PERMISSION: Record<string, PermissionKey> = {
  priced: 'changeorder.price',
  internal_approved: 'changeorder.approve_internal',
  customer_presented: 'changeorder.present',
  customer_approved: 'changeorder.present',
  customer_rejected: 'changeorder.present',
  authorized: 'changeorder.authorize',
  void: 'changeorder.approve_internal',
};

/** Mirrors CO_TRANSITIONS in server/domain/workflow/gates.ts (server is authoritative). */
const CO_NEXT: Record<string, string[]> = {
  requested: ['priced', 'void'],
  priced: ['internal_approved', 'requested', 'void'],
  internal_approved: ['customer_presented', 'priced', 'void'],
  customer_presented: ['customer_approved', 'customer_rejected', 'priced', 'void'],
  customer_approved: ['authorized', 'customer_presented', 'void'],
  customer_rejected: ['void'],
  authorized: [],
  void: [],
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');

/** `<input type="date">` gives YYYY-MM-DD; pin it to local midnight before sending epoch ms. */
const dateToMs = (v: string): number | null => (v ? fromLocalInputValue(`${v}T00:00`) : null);

/** The list endpoint computes these; the detail payload only ships payments. */
function collectedOf(inv: any): number {
  if (typeof inv?.collected === 'number') return inv.collected;
  const payments = Array.isArray(inv?.payments) ? inv.payments : [];
  return payments.reduce((a: number, p: any) => a + (Number(p?.amount) || 0), 0);
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */

export default function ProjectDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState('jobs');

  const [jobOpen, setJobOpen] = useState(false);
  const [coOpen, setCoOpen] = useState(false);
  const [transition, setTransition] = useState<{ co: any; to: string } | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [payTarget, setPayTarget] = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<ApiError | null>(null);

  const detail = useFetch<ProjectDetailData>(id ? `/projects/${id}` : null, [id]);
  const invoicesRes = useFetch<{ rows: any[]; total: number }>(
    id ? `/invoices${qs({ projectId: id, limit: 100 })}` : null,
    [id],
  );
  const roster = useFetch<{ rows: any[] }>('/auth/roster', []);
  const config = useFetch<any>('/config', []);

  const data = detail.data;
  const project = data?.project ?? null;

  // The server sends `financials: null` + `financialsRestricted: true` for roles
  // without production.financials. Both flags must agree before any money renders.
  const restricted = !data || data.financialsRestricted === true || data.financials == null;
  const moneyVisible = can('production.financials') && !restricted;

  const reloadAll = () => {
    detail.reload();
    invoicesRes.reload();
  };

  if (detail.loading && !data) return <Loading label="Loading project…" />;
  if (!data || !project) {
    return (
      <div className="stack">
        <LinkButton to="/production" size="sm">
          ← Back to production
        </LinkButton>
        <ErrorState error={detail.error ?? new Error('Project not found.')} onRetry={detail.reload} />
      </div>
    );
  }

  const jobs: any[] = data.jobs ?? [];
  const draws: any[] = data.draws ?? [];
  const changeOrders: any[] = data.changeOrders ?? [];
  const recentReports: any[] = data.recentReports ?? [];
  const openTasks: any[] = data.openTasks ?? [];
  const invoiceRows: any[] = invoicesRes.data?.rows ?? data.invoices ?? [];
  const rosterRows: any[] = roster.data?.rows ?? [];
  const foremen = rosterRows.filter((r) => r.role_key === 'foreman');
  const foremanOptions = foremen.length ? foremen : rosterRows;

  // Crews have no directory endpoint — the crews already on this project are the
  // only ids the server will accept for a new job.
  const crewMap = new Map<string, string>();
  for (const j of jobs) {
    if (j?.crew_id && !crewMap.has(String(j.crew_id))) crewMap.set(String(j.crew_id), String(j.crew_name ?? ''));
  }
  const crews = [...crewMap].map(([value, name]) => ({ value, name }));

  const tradeSet = new Set<string>();
  for (const t of config.data?.trades ?? []) if (t) tradeSet.add(String(t));
  for (const j of jobs) if (j?.trade) tradeSet.add(String(j.trade));
  const trades = [...tradeSet];

  const drawItems = draws.flatMap((s: any) =>
    (Array.isArray(s?.items) ? s.items : []).map((i: any) => ({ ...i, schedule_version: s.version })),
  );

  const m = (v: any) => (moneyVisible ? money(v) : '—');
  const fin: any = data.financials ?? null;

  const tabs = [
    { key: 'jobs', label: 'Jobs', count: jobs.length },
    ...(can('production.financials') ? [{ key: 'financials', label: 'Financials' }] : []),
    { key: 'change-orders', label: 'Change orders', count: changeOrders.length },
    { key: 'invoices', label: 'Invoices', count: invoiceRows.length },
    { key: 'draws', label: 'Draws', count: drawItems.length },
    { key: 'reports', label: 'Reports', count: recentReports.length },
  ];

  const issueInvoice = async (inv: any) => {
    try {
      await post(`/invoices/${inv.id}/issue`, {});
      toast.success('Invoice issued', `${inv.invoice_no ?? 'Invoice'} is now sent.`);
      reloadAll();
    } catch (e) {
      toast.error('Could not issue the invoice', errMsg(e));
    }
  };

  const removeInvoice = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await del(`/invoices/${deleteTarget.id}`);
      toast.success('Invoice deleted', `${deleteTarget.invoice_no ?? 'Invoice'} removed.`);
      setDeleteTarget(null);
      reloadAll();
    } catch (e) {
      // 409 when payments exist — keep the dialog open with the server's reason.
      setDeleteErr(e as ApiError);
    } finally {
      setDeleting(false);
    }
  };

  /* ------------------------------ header ------------------------------ */

  const header = (
    <PageHead
      title={<span className="mono">{String(project.project_no ?? 'Project')}</span>}
      sub={
        <span>
          <b>{project.name || 'Untitled project'}</b>
          {project.address ? ` · ${project.address}` : ''}
          {project.contact_name ? ` · ${project.contact_name}` : ''}
          {project.company_name ? ` · ${project.company_name}` : ''}
        </span>
      }
      actions={
        <div className="row wrap">
          <LinkButton to="/production" size="sm">
            ← Production
          </LinkButton>
          {project.deal_id ? (
            <LinkButton to={`/deals/${project.deal_id}`} size="sm">
              Open deal
            </LinkButton>
          ) : null}
          {can('production.write') ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Icon name="plus" size={14} />}
              onClick={() => setJobOpen(true)}
            >
              New job
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="row wrap">
        <Badge tone={PROJECT_TONE[String(project.status ?? '')] ?? 'neutral'}>
          {project.status ? titleCase(String(project.status)) : '—'}
        </Badge>
        <Badge tone="outline">{project.project_type ? titleCase(String(project.project_type)) : '—'}</Badge>
        {project.contact_name ? <Badge tone="neutral">{project.contact_name}</Badge> : null}
        {project.deal_no ? <Badge tone="violet">{project.deal_no}</Badge> : null}
      </div>
    </PageHead>
  );

  /* ------------------------------ panels ------------------------------ */

  const renderJobs = () => {
    if (!jobs.length) {
      return (
        <EmptyState
          title="No jobs on this project yet"
          icon={<Icon name="production" size={22} />}
          action={
            can('production.write') ? (
              <Button variant="primary" onClick={() => setJobOpen(true)}>
                Create the first job
              </Button>
            ) : null
          }
        >
          A job carries the scope, schedule, crew, costs and daily reports for one trade.
        </EmptyState>
      );
    }
    return (
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Job</th>
              <th>Trade</th>
              <th>Name</th>
              <th>Stage</th>
              <th className="num">Days in stage</th>
              <th>Crew</th>
              <th>Foreman</th>
              <th>Scheduled</th>
              {moneyVisible ? <th className="num">Estimated cost</th> : null}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={String(j.id)}>
                <td className="mono strong nowrap">{j.job_no ?? '—'}</td>
                <td className="nowrap">{j.trade ? (TRADE_LABELS[j.trade] ?? titleCase(String(j.trade))) : '—'}</td>
                <td className="truncate" style={{ maxWidth: 180 }} title={j.name ?? ''}>
                  {j.name || '—'}
                </td>
                <td>
                  <Badge tone={JOB_STAGE_TONE[String(j.stage ?? '')] ?? 'neutral'}>
                    {j.stage ? stageLabel(String(j.stage)) : '—'}
                  </Badge>
                </td>
                <td className="num">{typeof j.days_in_stage === 'number' ? j.days_in_stage : '—'}</td>
                <td className="nowrap">{j.crew_name ?? '—'}</td>
                <td className="nowrap">{j.foreman_name ?? '—'}</td>
                <td className="nowrap small">
                  {dateShort(j.scheduled_start)}
                  {j.scheduled_end ? ` → ${dateShort(j.scheduled_end)}` : ''}
                </td>
                {moneyVisible ? <td className="num nowrap">{m(j.estimated_cost)}</td> : null}
                <td>
                  <LinkButton to={`/jobs/${j.id}`} size="sm">
                    Open
                  </LinkButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderFinancials = () => {
    if (!can('production.financials')) {
      return <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>;
    }
    if (!fin) return <Loading label="Loading financials…" />;

    const gm = fin.grossMargin;
    const gmTone: 'good' | 'warn' | 'bad' | undefined =
      typeof gm === 'number' ? (gm >= 0.2 ? 'good' : gm >= 0.1 ? 'warn' : 'bad') : undefined;
    const byCategory: any[] = Array.isArray(fin.byCategory) ? fin.byCategory : [];

    return (
      <div className="stack">
        <div className="grid grid-3">
          <Stat label="Current contract value" value={money(fin.currentContractValue)} tone="accent" />
          <Stat label="Projected final cost" value={money(fin.projectedFinalCost)} />
          <Stat
            label="Gross profit"
            value={money(fin.grossProfit)}
            detail={pct(gm) + ' margin'}
            tone={typeof gm === 'number' && gm < 0 ? 'bad' : 'good'}
          />
        </div>
        {typeof gm === 'number' ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <span className="grow small strong">Gross margin</span>
              <span className="small muted">{pct(gm)}</span>
            </div>
            <Meter value={gm * 100} tone={gmTone} />
          </div>
        ) : (
          <div className="small muted">Gross margin is not available for this project. —</div>
        )}

        <div className="grid grid-3">
          <Stat label="Estimated cost" value={money(fin.estimatedCost)} />
          <Stat label="Committed cost" value={money(fin.committedCost)} />
          <Stat label="Actual cost" value={money(fin.actualCost)} />
        </div>

        <div className="grid grid-3">
          <Stat label="Invoiced" value={money(fin.invoiced)} />
          <Stat label="Collected" value={money(fin.collected)} tone="good" />
          <Stat label="Remaining receivable" value={money(fin.remainingReceivable)} tone="info" />
        </div>

        <Callout tone="grey">
          Committed rows are additional commitments that have not been expensed yet, so projected
          final cost = actuals + commitments (no overlap subtraction — committed and actual rows are
          recorded separately).
        </Callout>

        {byCategory.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Estimated</th>
                  <th className="num">Committed</th>
                  <th className="num">Actual</th>
                  <th className="num">Variance</th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map((c) => {
                  const variance = Number(c.actual ?? 0) - Number(c.estimated ?? 0);
                  return (
                    <tr key={String(c.key ?? c.name)}>
                      <td>{c.name ?? '—'}</td>
                      <td className="num nowrap">{money(c.estimated)}</td>
                      <td className="num nowrap">{money(c.committed)}</td>
                      <td className="num nowrap">{money(c.actual)}</td>
                      <td
                        className="num nowrap"
                        style={variance > 0 ? { color: 'var(--red)', fontWeight: 600 } : undefined}
                      >
                        {money(variance)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No cost categories yet" icon={<Icon name="dollar" size={22} />}>
            Categories appear once estimates and job costs are recorded.
          </EmptyState>
        )}
      </div>
    );
  };

  const renderChangeOrders = () => (
    <div className="stack">
      <Callout tone="blue">
        Creating a change order is only a <b>request</b>. The work is not authorized until the
        change order is priced, approved internally, presented to and approved by the customer, and
        finally moved to <b>authorized</b> — nothing is authorized when the request is created.
      </Callout>

      {can('changeorder.request') ? (
        <div className="row wrap">
          <span className="spacer" />
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setCoOpen(true)}>
            New change order
          </Button>
        </div>
      ) : null}

      {changeOrders.length === 0 ? (
        <EmptyState
          title="No change orders"
          icon={<Icon name="file" size={22} />}
          action={
            can('changeorder.request') ? (
              <Button variant="primary" onClick={() => setCoOpen(true)}>
                New change order
              </Button>
            ) : null
          }
        >
          A change order starts as a request and only becomes billable work once the customer
          approves it.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Change order</th>
                <th>Title</th>
                <th>Status</th>
                <th className="num">Internal</th>
                <th className="num">Customer</th>
                <th>Requested by</th>
                <th>Dates</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {changeOrders.map((co) => {
                const targets = (CO_NEXT[String(co.status ?? '')] ?? []).filter((t) => CO_LABEL[t]);
                return (
                  <tr key={String(co.id)}>
                    <td className="mono strong nowrap">{co.co_no ?? '—'}</td>
                    <td>
                      <div className="truncate" style={{ maxWidth: 200 }} title={co.title ?? ''}>
                        {co.title || '—'}
                      </div>
                      {co.schedule_impact ? (
                        <div className="tiny muted truncate" style={{ maxWidth: 200 }} title={co.schedule_impact}>
                          {co.schedule_impact}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={CO_TONE[String(co.status ?? '')] ?? 'neutral'}>
                        {co.status ? titleCase(String(co.status)) : '—'}
                      </Badge>
                    </td>
                    <td className="num nowrap">{m(co.internal_amount)}</td>
                    <td className="num nowrap">{m(co.customer_amount)}</td>
                    <td className="nowrap small">{co.requested_by_name ?? '—'}</td>
                    <td className="nowrap tiny muted">
                      <div>Requested {dateShort(co.requested_at ?? co.created_at)}</div>
                      {co.authorized_at ? <div>Authorized {dateShort(co.authorized_at)}</div> : null}
                      {co.customer_decided_at ? <div>Customer decided {dateShort(co.customer_decided_at)}</div> : null}
                    </td>
                    <td>
                      <div className="row wrap">
                        {targets.length === 0 ? (
                          <span className="tiny muted">Final status</span>
                        ) : (
                          targets.map((t) => {
                            const perm = CO_PERMISSION[t];
                            const allowed = !perm || can(perm);
                            if (!allowed) return null;
                            const isVoid = t === 'void';
                            const isFirst = t === targets[0];
                            return (
                              <Button
                                key={t}
                                size="sm"
                                variant={isVoid ? 'danger' : isFirst ? 'primary' : 'default'}
                                title={allowed ? undefined : `Requires ${perm}`}
                                onClick={() => setTransition({ co, to: t })}
                              >
                                {CO_LABEL[t]}
                              </Button>
                            );
                          })
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderInvoices = () => (
    <div className="stack">
      <div className="row wrap">
        <span className="small muted">{invoiceRows.length} invoice(s)</span>
        <span className="spacer" />
        {can('invoice.manage') ? (
          <Button size="sm" variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setInvoiceOpen(true)}>
            New invoice
          </Button>
        ) : null}
      </div>

      {invoicesRes.error ? <ErrorState error={invoicesRes.error} onRetry={invoicesRes.reload} /> : null}
      {invoicesRes.loading && !invoicesRes.data ? <Loading label="Loading invoices…" /> : null}

      {!invoicesRes.loading && !invoicesRes.error && invoiceRows.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          icon={<Icon name="dollar" size={22} />}
          action={
            can('invoice.manage') ? (
              <Button variant="primary" onClick={() => setInvoiceOpen(true)}>
                New invoice
              </Button>
            ) : null
          }
        >
          Invoices bill against the draw schedule; payments collected against them are applied on
          this tab.
        </EmptyState>
      ) : invoiceRows.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">Collected</th>
                <th className="num">Balance</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoiceRows.map((inv) => {
                const collected = collectedOf(inv);
                const balance = Number(inv.balance ?? Number(inv.amount ?? 0) - collected);
                const overdue =
                  inv.due_at != null &&
                  Number(inv.due_at) < Date.now() &&
                  (inv.status === 'sent' || inv.status === 'partial');
                return (
                  <tr key={String(inv.id)}>
                    <td className="mono strong nowrap">{inv.invoice_no ?? '—'}</td>
                    <td>
                      <div className="row wrap">
                        <Badge tone={INVOICE_TONE[String(inv.status ?? '')] ?? 'neutral'}>
                          {inv.status ? titleCase(String(inv.status)) : '—'}
                        </Badge>
                        {overdue ? <Badge tone="red">Overdue</Badge> : null}
                      </div>
                    </td>
                    <td className="num nowrap">{m(inv.amount)}</td>
                    <td className="num nowrap">{m(collected)}</td>
                    <td className="num nowrap">{m(balance)}</td>
                    <td className="nowrap">{dateShort(inv.issued_at)}</td>
                    <td className="nowrap">{dateShort(inv.due_at)}</td>
                    <td>
                      <div className="row wrap">
                        {can('invoice.manage') && inv.status === 'draft' ? (
                          <Button size="sm" onClick={() => issueInvoice(inv)}>
                            Issue
                          </Button>
                        ) : null}
                        {can('invoice.manage') && inv.status !== 'void' && balance > 0 ? (
                          <Button size="sm" variant="success" onClick={() => setPayTarget(inv)}>
                            Record payment
                          </Button>
                        ) : null}
                        {can('invoice.manage') ? (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setDeleteErr(null);
                              setDeleteTarget(inv);
                            }}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );

  const renderDraws = () => {
    const drawTotal = drawItems.reduce((a, i) => a + (Number(i.amount) || 0), 0);
    const billed = invoiceRows
      .filter((i) => String(i.status ?? '') !== 'void')
      .reduce((a, i) => a + (Number(i.amount) || 0), 0);

    if (!drawItems.length) {
      return (
        <EmptyState title="No draw schedule" icon={<Icon name="calendar" size={22} />}>
          The draw schedule carries over from the deal when it is marked Won — nothing has been
          carried onto this project yet.
        </EmptyState>
      );
    }

    return (
      <div className="stack">
      {moneyVisible ? (
        <div className="grid grid-3">
          <Stat label="Scheduled draws" value={money(drawTotal)} tone="accent" />
          <Stat label="Billed" value={money(billed)} tone="info" />
          <Stat label="Remaining" value={money(drawTotal - billed)} />
        </div>
      ) : null}

        {draws.map((schedule: any) => (
          <div className="table-wrap" key={String(schedule.id)}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="num">Seq</th>
                  <th>Milestone</th>
                  <th>Trigger</th>
                  <th className="num">%</th>
                  <th className="num">Amount</th>
                  <th>Condition</th>
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(schedule?.items) ? schedule.items : []).map((it: any) => (
                  <tr key={String(it.id)}>
                    <td className="num">{it.seq ?? '—'}</td>
                    <td className="strong">{it.milestone ?? '—'}</td>
                    <td className="small">{it.trigger || '—'}</td>
                    <td className="num">{typeof it.pct === 'number' ? `${it.pct}%` : '—'}</td>
                    <td className="num nowrap">{m(it.amount)}</td>
                    <td className="small muted">{it.condition || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    );
  };

  const renderReports = () => {
    const nameFor = (userId: any) => {
      if (!userId) return '—';
      const hit = rosterRows.find((r) => r.id === userId);
      return hit ? hit.name : String(userId);
    };

    return (
      <div className="stack">
        <Callout tone="blue">
          Daily reports are submitted from each job&apos;s page — this is the project-wide feed of
          the last 20.
        </Callout>

        {roster.error ? <p className="tiny muted">Roster unavailable: {errMsg(roster.error)}</p> : null}

        {recentReports.length === 0 ? (
          <EmptyState
            title="No daily reports yet"
            icon={<Icon name="file" size={22} />}
            action={
              jobs[0] ? (
                <LinkButton to={`/jobs/${jobs[0].id}`} variant="primary">
                  Open {jobs[0].job_no ?? 'the first job'}
                </LinkButton>
              ) : null
            }
          >
            Reports are written by the crew from the job page and count toward completion once
            submitted.
          </EmptyState>
        ) : (
          <div className="list">
            {recentReports.map((r) => (
              <div className="list-item" key={String(r.id)}>
                <div className="row wrap">
                  <span className="strong nowrap">{dateShort(r.report_date)}</span>
                  <Badge tone={REPORT_TONE[String(r.status ?? '')] ?? 'neutral'}>
                    {r.status ? titleCase(String(r.status)) : '—'}
                  </Badge>
                  <Badge tone="outline">{r.job_no ?? '—'}</Badge>
                  <span className="spacer" />
                  <span className="tiny muted">by {nameFor(r.foreman_id)}</span>
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {r.work_completed || '—'}
                </div>
                {r.blockers || r.delays ? (
                  <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>
                    {r.blockers ? `Blockers: ${r.blockers}` : ''}
                    {r.blockers && r.delays ? ' · ' : ''}
                    {r.delays ? `Delays: ${r.delays}` : ''}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {jobs[0] ? (
          <div className="row">
            <span className="spacer" />
            <LinkButton to={`/jobs/${jobs[0].id}`} size="sm">
              Submit a report on {jobs[0].job_no ?? 'a job'}
            </LinkButton>
          </div>
        ) : null}
      </div>
    );
  };

  const renderTab = () => {
    switch (tab) {
      case 'jobs':
        return renderJobs();
      case 'financials':
        return renderFinancials();
      case 'change-orders':
        return renderChangeOrders();
      case 'invoices':
        return renderInvoices();
      case 'draws':
        return renderDraws();
      case 'reports':
        return renderReports();
      default:
        return null;
    }
  };

  /* ------------------------------ rail ------------------------------ */

  const stageCounts = new Map<string, number>();
  for (const j of jobs) stageCounts.set(String(j.stage ?? ''), (stageCounts.get(String(j.stage ?? '')) ?? 0) + 1);

  const rail = (
    <aside className="stack">
      <Card title="Schedule" sub="Jobs grouped by stage">
        {jobs.length === 0 ? (
          <div className="small muted">No jobs to schedule yet.</div>
        ) : (
          <div className="list">
            {[...stageCounts].map(([stage, count]) => (
              <div className="list-item" key={stage}>
                <div className="row">
                  <Badge tone={JOB_STAGE_TONE[stage] ?? 'neutral'}>{stageLabel(stage)}</Badge>
                  <span className="spacer" />
                  <span className="strong num">{count}</span>
                </div>
              </div>
            ))}
            <div className="divider" />
            {jobs
              .slice()
              .sort((a, b) => Number(b.days_in_stage ?? 0) - Number(a.days_in_stage ?? 0))
              .slice(0, 6)
              .map((j) => (
                <div className="list-item" key={String(j.id)}>
                  <div className="row">
                    <span className="mono small">{j.job_no ?? '—'}</span>
                    <span className="spacer" />
                    <span className="tiny muted">{typeof j.days_in_stage === 'number' ? `${j.days_in_stage}d` : '—'}</span>
                  </div>
                  <div className="small truncate">{j.name || (j.trade ? titleCase(String(j.trade)) : '—')}</div>
                </div>
              ))}
          </div>
        )}
      </Card>

      <Card
        title="Open blockers"
        sub="Open tasks on this project"
        actions={<LinkButton to="/tasks" size="sm">All tasks</LinkButton>}
      >
        {openTasks.length === 0 ? (
          <div className="small">No open tasks — nothing is blocking closeout.</div>
        ) : (
          <div className="list">
            {openTasks.map((t) => (
              <div className="list-item" key={String(t.id)}>
                <div className="row">
                  <span className="grow truncate" title={t.title ?? ''}>
                    {t.title || '—'}
                  </span>
                  {Number(t.priority) === 1 ? <Badge tone="red">High</Badge> : null}
                </div>
                <div className="tiny muted">
                  {t.assignee_name ?? 'Unassigned'} · due {dateShort(t.due_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Compliance / closeout">
        <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
          Closeout needs every job through punch list to paid: submitted daily reports, no open
          blockers, no open tasks and an authorized completion on each job, then invoices collected.
        </div>
        <div style={{ marginTop: 10 }}>
          <LinkButton to="/tasks" size="sm">
            Review open tasks
          </LinkButton>
        </div>
      </Card>
    </aside>
  );

  /* ------------------------------ page ------------------------------ */

  return (
    <div className="stack">
      {header}

      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : null}

      {!moneyVisible ? (
        <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>
      ) : null}

      <div className="split-wide">
        <div className="stack">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          <Card>{renderTab()}</Card>
        </div>
        {rail}
      </div>

      {jobOpen ? (
        <NewJobModal
          projectId={String(project.id)}
          trades={trades}
          foremen={foremanOptions}
          crews={crews}
          canSeeMoney={moneyVisible}
          onClose={() => setJobOpen(false)}
          onSaved={(trade) => {
            setJobOpen(false);
            toast.success('Job created', `${trade} job added to ${project.project_no ?? 'the project'}.`);
            reloadAll();
          }}
        />
      ) : null}

      {coOpen ? (
        <NewChangeOrderModal
          projectId={String(project.id)}
          onClose={() => setCoOpen(false)}
          onSaved={(title) => {
            setCoOpen(false);
            toast.success('Change order requested', `"${title}" is now in the request queue.`);
            reloadAll();
          }}
        />
      ) : null}

      {transition ? (
        <CoTransitionModal
          co={transition.co}
          to={transition.to}
          onClose={() => setTransition(null)}
          onDone={() => {
            setTransition(null);
            reloadAll();
          }}
        />
      ) : null}

      {invoiceOpen ? (
        <NewInvoiceModal
          projectId={String(project.id)}
          drawItems={drawItems}
          onClose={() => setInvoiceOpen(false)}
          onSaved={(no) => {
            setInvoiceOpen(false);
            toast.success('Invoice created', no ? `${no} added.` : 'Invoice added.');
            reloadAll();
          }}
        />
      ) : null}

      {payTarget ? (
        <PaymentModal
          invoice={payTarget}
          onClose={() => setPayTarget(null)}
          onDone={() => {
            setPayTarget(null);
            reloadAll();
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete invoice"
          message={
            <>
              Delete <strong className="mono">{deleteTarget.invoice_no ?? 'this invoice'}</strong>?
              This cannot be undone.
            </>
          }
          confirmLabel="Delete invoice"
          loading={deleting}
          onConfirm={removeInvoice}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteErr(null);
          }}
        >
          {deleteErr ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="warn-state" role="alert">
                {deleteErr.message}
              </div>
              {deleteErr.status === 409 && deleteErr.blockers.length ? (
                <BlockerList items={deleteErr.blockers.map((b) => ({ label: b.label, detail: b.detail }))} />
              ) : null}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* New job                                                             */
/* ================================================================== */

function NewJobModal({
  projectId,
  trades,
  foremen,
  crews,
  canSeeMoney,
  onClose,
  onSaved,
}: {
  projectId: string;
  trades: string[];
  foremen: any[];
  crews: Array<{ value: string; name: string }>;
  canSeeMoney: boolean;
  onClose: () => void;
  onSaved: (trade: string) => void;
}) {
  const [trade, setTrade] = useState('');
  const [name, setName] = useState('');
  const [estimatedCost, setEstimatedCost] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [scheduledEnd, setScheduledEnd] = useState('');
  const [foremanId, setForemanId] = useState('');
  const [crewId, setCrewId] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const submit = async () => {
    if (!trade) return;
    setPending(true);
    setErr(null);
    try {
      await post('/jobs', {
        projectId,
        trade,
        name: name.trim(),
        // Cost is only ever sent for roles that may see it — everyone else keeps 0.
        estimatedCost: canSeeMoney && estimatedCost !== '' ? Number(estimatedCost) : 0,
        scheduledStart: dateToMs(scheduledStart),
        scheduledEnd: dateToMs(scheduledEnd),
        foremanId: foremanId || null,
        crewId: crewId || null,
      });
      onSaved(trade);
    } catch (e) {
      // 409 = this project already has a job for that trade; message says which one.
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="New job"
      sub="One job per trade per project — the server rejects a duplicate trade."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!trade}>
            Create job
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? (
          <div className={err.status === 409 ? 'warn-state' : 'error-state'} role="alert">
            {err.message}
          </div>
        ) : null}

        <div className="form-grid">
          <Select
            label="Trade"
            required
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            placeholder="Select a trade"
            error={err?.fieldErrors?.trade}
            options={trades.map((t) => ({ value: t, label: TRADE_LABELS[t] ?? titleCase(t) }))}
          />
          <Input
            label="Job name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={err?.fieldErrors?.name}
            placeholder="e.g. Tear-off & re-roof"
          />
          {canSeeMoney ? (
            <Input
              label="Estimated cost"
              type="number"
              min="0"
              step="any"
              value={estimatedCost}
              onChange={(e) => setEstimatedCost(e.target.value)}
              error={err?.fieldErrors?.estimatedCost}
            />
          ) : null}
          <Input
            label="Scheduled start"
            type="date"
            value={scheduledStart}
            onChange={(e) => setScheduledStart(e.target.value)}
            error={err?.fieldErrors?.scheduledStart}
          />
          <Input
            label="Scheduled end"
            type="date"
            value={scheduledEnd}
            onChange={(e) => setScheduledEnd(e.target.value)}
            error={err?.fieldErrors?.scheduledEnd}
          />
          <Select
            label="Foreman"
            value={foremanId}
            onChange={(e) => setForemanId(e.target.value)}
            placeholder="Unassigned"
            error={err?.fieldErrors?.foremanId}
            options={foremen.map((r) => ({ value: String(r.id), label: String(r.name) }))}
          />
          {crews.length ? (
            <Select
              label="Crew"
              value={crewId}
              onChange={(e) => setCrewId(e.target.value)}
              placeholder="Unassigned"
              error={err?.fieldErrors?.crewId}
              hint="Crews already assigned on this project."
              options={crews.map((c) => ({ value: c.value, label: c.name || c.value }))}
            />
          ) : null}
        </div>

        <Callout tone="grey">
          The job starts in <b>unscheduled</b> — add a start date before it can be moved to
          scheduled.
        </Callout>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* New change order (a request — nothing is authorized here)           */
/* ================================================================== */

function NewChangeOrderModal({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduleImpact, setScheduleImpact] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const submit = async () => {
    if (!title.trim()) return;
    setPending(true);
    setErr(null);
    try {
      await post('/change-orders', {
        projectId,
        title: title.trim(),
        description: description.trim(),
        scheduleImpact: scheduleImpact.trim(),
      });
      onSaved(title.trim());
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="New change order"
      sub="Creates a request only — no work is authorized."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!title.trim()}>
            Request change
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? (
          <div className={err.status === 409 ? 'warn-state' : 'error-state'} role="alert">
            {err.message}
          </div>
        ) : null}
        <Input
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={err?.fieldErrors?.title}
          placeholder="e.g. Add ridge vent"
        />
        <TextArea
          label="Description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={err?.fieldErrors?.description}
          hint="At least a sentence — pricing and approval need the changed scope."
        />
        <Input
          label="Schedule impact"
          value={scheduleImpact}
          onChange={(e) => setScheduleImpact(e.target.value)}
          error={err?.fieldErrors?.scheduleImpact}
          placeholder="e.g. +3 days"
        />
        <Callout tone="blue">
          Pricing, internal approval, customer approval and authorization are separate, gated
          steps — this request authorizes nothing.
        </Callout>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Change-order transition                                             */
/* ================================================================== */

function CoTransitionModal({
  co,
  to,
  onClose,
  onDone,
}: {
  co: any;
  to: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [internal, setInternal] = useState(co.internal_amount == null ? '' : String(co.internal_amount));
  const [customer, setCustomer] = useState(co.customer_amount == null ? '' : String(co.customer_amount));
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const needsAmounts = to === 'priced';
  const needsReason = to === 'customer_approved' || to === 'customer_rejected';
  const amountsOk =
    !needsAmounts ||
    (Number(internal) > 0 && Number(customer) > 0);

  // 409 carries the workflow gate's blocker list — show it, keep the dialog open.
  const blockers =
    err && err.status === 409
      ? err.blockers.map((b) => ({ label: b.label, detail: b.detail }))
      : [];

  const submit = async () => {
    if (!amountsOk) return;
    setPending(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { to };
      if (needsAmounts) {
        body.internalAmount = Number(internal);
        body.customerAmount = Number(customer);
      }
      if (needsReason) body.reason = reason.trim();
      await post(`/change-orders/${co.id}/transition`, body);
      toast.success('Change order updated', `${co.co_no ?? ''} → ${titleCase(to)}.`);
      onDone();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={CO_LABEL[to] ?? titleCase(to)}
      sub={`${co.co_no ?? 'Change order'} · currently ${titleCase(String(co.status ?? ''))}`}
      onClose={onClose}
      size="sm"
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={to === 'void' ? 'danger' : 'primary'}
            onClick={submit}
            loading={pending}
            disabled={!amountsOk}
          >
            {CO_LABEL[to] ?? 'Confirm'}
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? (
          <div className={err.status === 409 ? 'warn-state' : 'error-state'} role="alert">
            {err.message}
          </div>
        ) : null}
        {blockers.length ? <BlockerList items={blockers} /> : null}

        {needsAmounts ? (
          <>
            <Input
              label="Internal cost"
              required
              type="number"
              min="0"
              step="any"
              value={internal}
              onChange={(e) => setInternal(e.target.value)}
              error={err?.fieldErrors?.internalAmount}
              hint="What this change costs us."
            />
            <Input
              label="Customer price"
              required
              type="number"
              min="0"
              step="any"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              error={err?.fieldErrors?.customerAmount}
              hint="What the customer is charged."
            />
          </>
        ) : null}

        {needsReason ? (
          <TextArea
            label="Reason / note"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="Recorded as the customer's decision note."
          />
        ) : null}

        <Callout tone={to === 'authorized' ? 'green' : 'grey'}>
          {to === 'authorized'
            ? 'Authorizing puts this change order into the contract value and tells Production the work is approved. It only passes after the customer has approved.'
            : 'The server re-runs the change-order workflow gate on every transition — blockers appear here if a step is missing.'}
        </Callout>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Invoice + payment                                                   */
/* ================================================================== */

function NewInvoiceModal({
  projectId,
  drawItems,
  onClose,
  onSaved,
}: {
  projectId: string;
  drawItems: any[];
  onClose: () => void;
  onSaved: (invoiceNo?: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [drawItemId, setDrawItemId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const amountOk = amount !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0;

  const submit = async () => {
    if (!amountOk) return;
    setPending(true);
    setErr(null);
    try {
      const res = await post<{ row?: any }>('/invoices', {
        projectId,
        amount: Number(amount),
        drawItemId: drawItemId || null,
        dueAt: dateToMs(dueAt),
        notes: notes.trim(),
      });
      onSaved(res?.row?.invoice_no);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="New invoice"
      sub="Created as a draft — issue it to send."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!amountOk}>
            Create invoice
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? (
          <div className={err.status === 409 ? 'warn-state' : 'error-state'} role="alert">
            {err.message}
          </div>
        ) : null}
        <div className="form-grid">
          <Input
            label="Amount"
            required
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={err?.fieldErrors?.amount ?? (amount !== '' && !amountOk ? 'Amount must be greater than zero.' : undefined)}
          />
          <Input
            label="Due date"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            error={err?.fieldErrors?.dueAt}
          />
          {drawItems.length ? (
            <Select
              label="Draw item"
              value={drawItemId}
              onChange={(e) => setDrawItemId(e.target.value)}
              placeholder="Not tied to a draw"
              error={err?.fieldErrors?.drawItemId}
              options={drawItems.map((i) => ({
                value: String(i.id),
                label: `#${i.seq ?? '?'} ${i.milestone ?? 'Milestone'}`,
              }))}
            />
          ) : null}
        </div>
        <TextArea
          label="Notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={err?.fieldErrors?.notes}
        />
      </div>
    </Modal>
  );
}

function PaymentModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const collected = collectedOf(invoice);
  const balance = Number(invoice.balance ?? Number(invoice.amount ?? 0) - collected);

  const [amount, setAmount] = useState(balance > 0 ? String(balance) : '');
  const [receivedAt, setReceivedAt] = useState('');
  const [method, setMethod] = useState('other');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const amountNum = Number(amount);
  const amountOk = amount !== '' && Number.isFinite(amountNum) && amountNum > 0 && amountNum <= balance + 0.004;
  const overBalance = amount !== '' && Number.isFinite(amountNum) && amountNum > balance + 0.004;

  const submit = async () => {
    if (!amountOk) return;
    setPending(true);
    setErr(null);
    try {
      await post(`/invoices/${invoice.id}/payments`, {
        amount: amountNum,
        receivedAt: dateToMs(receivedAt),
        method,
        reference: reference.trim(),
      });
      toast.success('Payment recorded', `${invoice.invoice_no ?? 'Invoice'} updated.`);
      onDone();
    } catch (e) {
      // 422 when the amount exceeds the balance — message comes from the server.
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Record payment"
      sub={`${invoice.invoice_no ?? 'Invoice'} · balance ${money(balance)}`}
      onClose={onClose}
      size="sm"
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="success" onClick={submit} loading={pending} disabled={!amountOk}>
            Record payment
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? (
          <div className={err.status === 409 ? 'warn-state' : 'error-state'} role="alert">
            {err.message}
          </div>
        ) : null}
        <div className="form-grid">
          <Input
            label="Amount"
            required
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={
              err?.fieldErrors?.amount ??
              (overBalance ? `A payment cannot exceed the balance of ${money(balance)}.` : undefined)
            }
            hint={`Balance: ${money(balance)}`}
          />
          <Input
            label="Received"
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
          <Select
            label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            options={[
              { value: 'other', label: 'Other' },
              { value: 'ach', label: 'ACH' },
              { value: 'check', label: 'Check' },
              { value: 'card', label: 'Card' },
              { value: 'cash', label: 'Cash' },
            ]}
          />
        </div>
        <Input
          label="Reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Check no, transfer id…"
        />
      </div>
    </Modal>
  );
}
