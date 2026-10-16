import { Fragment, useState } from 'react';
import { useParams } from 'react-router-dom';
import { del, patch, post, qs, ApiError } from '../../lib/api';
import { useFetch } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import {
  Badge,
  BlockerList,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormActions,
  Input,
  KeyValue,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Segmented,
  Select,
  Stat,
  Tabs,
  TextArea,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  dateShort,
  daysSince,
  fromLocalInputValue,
  money,
  stageLabel,
  titleCase,
  toLocalInputValue,
  TRADE_LABELS,
} from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Pipeline (mirrors server/domain/workflow/gates.ts — server wins)    */
/* ------------------------------------------------------------------ */

const JOB_STAGES = [
  'unscheduled',
  'scheduled',
  'in_progress',
  'punch_list',
  'complete',
  'invoiced',
  'paid',
] as const;

const JOB_TRANSITIONS: Record<string, string[]> = {
  unscheduled: ['scheduled'],
  scheduled: ['in_progress', 'unscheduled'],
  in_progress: ['punch_list', 'scheduled'],
  punch_list: ['complete', 'in_progress'],
  complete: ['invoiced', 'punch_list'],
  invoiced: ['paid', 'complete'],
  paid: [],
};

const STAGE_TONE: Record<string, Tone> = {
  unscheduled: 'neutral',
  scheduled: 'blue',
  in_progress: 'green',
  punch_list: 'amber',
  complete: 'violet',
  invoiced: 'blue',
  paid: 'accent',
};

const REPORT_TONE: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'blue',
  approved: 'green',
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

const TASK_TYPES = ['task', 'follow_up', 'call', 'text', 'email', 'site_visit', 'document'];

interface JobDetailData {
  job: any;
  // The server flattens project/contact/crew/foreman into the job row; it also
  // ships them as siblings in some builds — read both shapes defensively.
  project?: any;
  contact?: any;
  crew?: any;
  foreman?: any;
  dailyReports: any[];
  costs: any[];
  changeOrders: any[];
  tasks: any[];
  documents: any[];
  stageHistory: any[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');

const pad = (n: number) => String(n).padStart(2, '0');

/** `<input type="date">` wants YYYY-MM-DD. */
const dayInput = (v: number | string | null | undefined): string => toLocalInputValue(v).slice(0, 10);

const todayInput = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** YYYY-MM-DD read as local midnight — the API wants epoch ms. */
const dateToMs = (v: string): number | null => (v ? fromLocalInputValue(`${v}T00:00`) : null);

/** The server keeps one report per job per calendar day. */
function findReport(reports: any[], dateStr: string): any | null {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00`);
  if (Number.isNaN(target.getTime())) return null;
  for (const r of reports ?? []) {
    const d = new Date(Number(r?.report_date));
    if (
      !Number.isNaN(d.getTime()) &&
      d.getFullYear() === target.getFullYear() &&
      d.getMonth() === target.getMonth() &&
      d.getDate() === target.getDate()
    ) {
      return r;
    }
  }
  return null;
}

/**
 * Scope snapshot arrives as an object (the server parses it) but older rows and
 * hand-written rows can still be a JSON string — accept both, never throw.
 */
function parseScope(raw: unknown): { ok: boolean; data: any } {
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: true, data: {} };
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? { ok: true, data: parsed } : { ok: false, data: {} };
    } catch {
      return { ok: false, data: {} };
    }
  }
  if (raw && typeof raw === 'object') return { ok: true, data: raw };
  return { ok: true, data: {} };
}

function photoCount(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'string') {
    if (!raw.trim()) return 0;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Known server requirements per target stage (gates.ts) — shown before confirming. */
function requirementsFor(to: string): string[] {
  switch (to) {
    case 'scheduled':
      return ['A start date is required to schedule the job.'];
    case 'in_progress':
      return ['A crew or foreman must be assigned before work starts.'];
    case 'complete':
      return [
        'Daily reports have been submitted for this job.',
        'No open blockers (high-priority tasks).',
        'No open tasks remain (punch list or closeout).',
        'Completion has been authorized by a project manager.',
      ];
    case 'paid':
      return ['The outstanding invoice balance must be collected first.'];
    default:
      return ['No extra requirements — the stage order is the only rule.'];
  }
}

const allowedMoves = (from: string): string[] => JOB_TRANSITIONS[from] ?? [];

function forwardMove(from: string): string | null {
  const idx = JOB_STAGES.indexOf(from as (typeof JOB_STAGES)[number]);
  const hit = allowedMoves(from).find((s) => JOB_STAGES.indexOf(s as (typeof JOB_STAGES)[number]) > idx);
  return hit ?? null;
}

function backMove(from: string): string | null {
  const idx = JOB_STAGES.indexOf(from as (typeof JOB_STAGES)[number]);
  const hit = allowedMoves(from).find((s) => JOB_STAGES.indexOf(s as (typeof JOB_STAGES)[number]) < idx);
  return hit ?? null;
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */

export default function JobDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can, user } = useAuth();
  const [tab, setTab] = useState('scope');

  const jobRes = useFetch<JobDetailData>(id ? `/jobs/${id}` : null, [id]);
  const costsRes = useFetch<{ rows: any[]; total: number }>(
    id ? `/jobs/costs${qs({ jobId: id, limit: 200 })}` : null,
    [id],
  );
  const config = useFetch<any>('/config', []);
  const roster = useFetch<{ rows: any[] }>('/auth/roster', []);

  // Stage movement
  const [advanceTo, setAdvanceTo] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [advanceErr, setAdvanceErr] = useState<ApiError | null>(null);

  // Costs
  const [costModal, setCostModal] = useState<{ row?: any } | null>(null);
  const [deleteCost, setDeleteCost] = useState<any | null>(null);
  const [deletingCost, setDeletingCost] = useState(false);
  const [deleteCostErr, setDeleteCostErr] = useState<ApiError | null>(null);

  // Reports / tasks
  const [reportOpen, setReportOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const data = jobRes.data;
  const job = data?.job ?? null;

  /**
   * /jobs/:id carries no financials flag, so the permission check is the only
   * server signal available here — cost and price stay hidden without it.
   */
  const moneyVisible = can('production.financials');
  const canWrite = can('production.write');
  const canAuthorize = can('production.financials') || user?.role === 'pm';

  const reloadAll = () => {
    jobRes.reload();
    costsRes.reload();
  };

  const openAdvance = (to: string) => {
    setAdvanceTo(to);
    setAuthChecked(false);
    setAdvanceErr(null);
  };

  const doAdvance = async () => {
    if (!advanceTo || !job) return;
    setAdvancing(true);
    setAdvanceErr(null);
    try {
      await post(`/jobs/${job.id}/advance`, {
        to: advanceTo,
        authorized: advanceTo === 'complete' && canAuthorize && authChecked,
      });
      toast.success('Stage updated', `${job.job_no} moved to ${stageLabel(advanceTo)}.`);
      setAdvanceTo(null);
      setAuthChecked(false);
      jobRes.reload();
    } catch (e) {
      // 409 → keep the dialog open and render the server's blocker list inline.
      const err = e as ApiError;
      setAdvanceErr(err);
      toast.error('Could not move the job', err.message);
    } finally {
      setAdvancing(false);
    }
  };

  const completeTask = async (t: any) => {
    setCompletingId(String(t.id));
    try {
      await post(`/tasks/${t.id}/complete`, {});
      toast.success('Task completed', t.title ?? 'Task closed.');
      jobRes.reload();
    } catch (e) {
      toast.error('Could not complete the task', errMsg(e));
    } finally {
      setCompletingId(null);
    }
  };

  const removeCost = async () => {
    if (!deleteCost) return;
    setDeletingCost(true);
    setDeleteCostErr(null);
    try {
      await del(`/jobs/costs/${deleteCost.id}`);
      toast.success('Cost removed', `${money(deleteCost.amount)} ${deleteCost.kind ?? ''} deleted.`);
      setDeleteCost(null);
      reloadAll();
    } catch (e) {
      setDeleteCostErr(e as ApiError);
    } finally {
      setDeletingCost(false);
    }
  };

  if (jobRes.loading && !data) return <Loading label="Loading job…" />;
  if (!data || !job) {
    return (
      <div className="stack">
        <LinkButton to="/production" size="sm">
          ← Back to production
        </LinkButton>
        <ErrorState error={jobRes.error ?? new Error('Job not found.')} onRetry={jobRes.reload} />
      </div>
    );
  }

  const dailyReports: any[] = data.dailyReports ?? [];
  const groupedCosts: any[] = data.costs ?? [];
  const jobTasks: any[] = data.tasks ?? [];
  const allChangeOrders: any[] = data.changeOrders ?? [];
  const rosterRows: any[] = roster.data?.rows ?? [];
  const categories: any[] = config.data?.costCategories ?? [];

  const projectId = String(job.project_id ?? data.project?.id ?? '');
  const projectName = String(job.project_name ?? data.project?.name ?? '—');
  const trade = String(job.trade ?? '');
  const stage = String(job.stage ?? 'unscheduled');
  const idx = JOB_STAGES.indexOf(stage as (typeof JOB_STAGES)[number]);
  const next = forwardMove(stage);
  const back = backMove(stage);
  const stageDays = daysSince(job.stage_entered_at);

  // Costs tab: line rows grouped by category + kind.
  const costRows: any[] = costsRes.data?.rows ?? [];
  const buckets = new Map<string, any[]>();
  for (const r of costRows) {
    const key = `${String(r.category_name ?? r.category_id ?? 'Uncategorized')}::${String(r.kind ?? '')}`;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  const costGroups = [...buckets].map(([key, rows]) => {
    const sep = key.lastIndexOf('::');
    return { key, category: key.slice(0, sep), kind: key.slice(sep + 2), rows };
  });
  costGroups.sort((a, b) => a.category.localeCompare(b.category) || a.kind.localeCompare(b.kind));

  const committed = groupedCosts
    .filter((c) => String(c.kind) === 'committed')
    .reduce((a, c) => a + (Number(c.total) || 0), 0);
  const actual = groupedCosts
    .filter((c) => String(c.kind) === 'actual')
    .reduce((a, c) => a + (Number(c.total) || 0), 0);

  // One report per job per day; submitted/approved are the ones that count.
  const startToday = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const reportToday = dailyReports.find(
    (r) => Number(r.report_date) >= startToday && Number(r.report_date) < startToday + 86_400_000,
  );
  const submittedCount = dailyReports.filter((r) => r.status === 'submitted' || r.status === 'approved').length;

  const jobChangeOrders = allChangeOrders.filter((c) => String(c.job_id ?? '') === String(job.id));

  const scope = parseScope(job.scope_snapshot);
  const scopeData = scope.data ?? {};
  const sellLines: any[] = Array.isArray(scopeData.sellLines) ? scopeData.sellLines : [];
  const costLines: any[] = Array.isArray(scopeData.costLines) ? scopeData.costLines : [];
  const hasScope = !!(
    String(scopeData.scopeText ?? '').trim() ||
    String(scopeData.exclusionsText ?? '').trim() ||
    sellLines.length ||
    costLines.length
  );

  const tabs = [
    { key: 'scope', label: 'Scope' },
    { key: 'costs', label: 'Costs', count: costRows.length },
    { key: 'reports', label: 'Reports', count: dailyReports.length },
    { key: 'tasks', label: 'Tasks', count: jobTasks.length },
    { key: 'changes', label: 'Changes', count: jobChangeOrders.length },
  ];

  /* ------------------------------ panels ------------------------------ */

  const lineTable = (title: string, lines: any[]) => (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">Qty</th>
            <th>Unit</th>
            {moneyVisible ? <th className="num">Unit price</th> : null}
            {moneyVisible ? <th className="num">Amount</th> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l: any, i: number) => {
            const qty = Number(l?.qty);
            const unitPrice = Number(l?.unitPrice);
            const amount = (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(unitPrice) ? unitPrice : 0);
            return (
              <tr key={String(l?.id ?? i)}>
                <td>{l?.description || <span className="muted">—</span>}</td>
                <td className="num">{Number.isFinite(qty) ? qty : '—'}</td>
                <td className="nowrap">{l?.unit || '—'}</td>
                {moneyVisible ? <td className="num nowrap">{money(unitPrice)}</td> : null}
                {moneyVisible ? <td className="num nowrap">{money(amount)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const renderScope = () => {
    if (!scope.ok) {
      return (
        <EmptyState title="Scope snapshot could not be read" icon={<Icon name="alert" size={22} />}>
          The stored scope snapshot for this job is not valid JSON, so nothing is shown rather than
          risking a wrong scope.
        </EmptyState>
      );
    }
    if (!hasScope) {
      return (
        <EmptyState title="No scope carried onto this job" icon={<Icon name="file" size={22} />}>
          Scope is copied from the released estimate when the deal is marked Won. This job was
          created without one.
        </EmptyState>
      );
    }
    return (
      <div className="stack">
        {!moneyVisible ? (
          <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>
        ) : null}

        <KeyValue
          items={[
            ['Estimate', scopeData.estimateId ? <span className="mono">{String(scopeData.estimateId)}</span> : '—'],
            ['Estimate version', scopeData.estimateVersion != null ? `v${scopeData.estimateVersion}` : '—'],
            ['Trade', trade ? (TRADE_LABELS[trade] ?? titleCase(trade)) : '—'],
          ]}
        />

        <div className="stack" style={{ gap: 6 }}>
          <div className="tiny muted strong">SCOPE OF WORK</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
            {String(scopeData.scopeText ?? '').trim() || '—'}
          </div>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <div className="tiny muted strong">EXCLUSIONS</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
            {String(scopeData.exclusionsText ?? '').trim() || '—'}
          </div>
        </div>

        {sellLines.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny muted strong">SELL LINES (CARRIED FROM THE ESTIMATE)</div>
            {lineTable('Description', sellLines)}
          </div>
        ) : null}

        {costLines.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny muted strong">COST LINES (CARRIED FROM THE ESTIMATE)</div>
            {lineTable('Description', costLines)}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCosts = () => (
    <div className="stack">
      {!moneyVisible ? (
        <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>
      ) : (
        <div className="grid grid-3">
          <Stat label="Committed" value={money(committed)} tone="info" />
          <Stat label="Actual" value={money(actual)} />
          <Stat
            label="Variance vs estimated"
            value={money(actual - Number(job.estimated_cost || 0))}
            tone={actual > Number(job.estimated_cost || 0) ? 'bad' : 'good'}
          />
        </div>
      )}

      <div className="row wrap">
        <span className="small muted">{costRows.length} cost line(s)</span>
        <span className="spacer" />
        {can('production.log_cost') ? (
          <Button
            size="sm"
            variant="primary"
            icon={<Icon name="plus" size={14} />}
            onClick={() => setCostModal({})}
          >
            Record cost
          </Button>
        ) : null}
      </div>

      {costsRes.error ? <ErrorState error={costsRes.error} onRetry={costsRes.reload} /> : null}
      {costsRes.loading && !costsRes.data ? <Loading label="Loading costs…" /> : null}

      {!costsRes.loading && !costsRes.error && costRows.length === 0 ? (
        <EmptyState
          title="No costs recorded"
          icon={<Icon name="dollar" size={22} />}
          action={
            can('production.log_cost') ? (
              <Button variant="primary" onClick={() => setCostModal({})}>
                Record cost
              </Button>
            ) : null
          }
        >
          Committed costs are promises to pay; actual costs are what has been expensed.
        </EmptyState>
      ) : costRows.length ? (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Category</th>
                <th>Kind</th>
                <th>Description</th>
                <th>Vendor</th>
                <th className="num">Amount</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            {costGroups.map((g) => (
              <tbody key={g.key}>
                <tr>
                  <td colSpan={7} className="small strong muted">
                    {g.category || 'Uncategorized'} · {g.kind ? titleCase(g.kind) : '—'} · {g.rows.length} line(s)
                  </td>
                </tr>
                {g.rows.map((r: any) => (
                  <tr key={String(r.id)}>
                    <td className="nowrap">{r.category_name ?? '—'}</td>
                    <td>
                      <Badge tone={r.kind === 'actual' ? 'blue' : 'violet'}>
                        {r.kind ? titleCase(String(r.kind)) : '—'}
                      </Badge>
                    </td>
                    <td className="truncate" style={{ maxWidth: 220 }} title={r.description ?? ''}>
                      {r.description || '—'}
                    </td>
                    <td className="nowrap">{r.vendor_name ?? '—'}</td>
                    <td className="num nowrap">{moneyVisible ? money(r.amount) : '—'}</td>
                    <td className="nowrap">{dateShort(r.occurred_at)}</td>
                    <td>
                      {can('production.log_cost') ? (
                        <div className="row wrap">
                          <Button size="sm" onClick={() => setCostModal({ row: r })}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setDeleteCostErr(null);
                              setDeleteCost(r);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
    </div>
  );

  const renderReports = () => (
    <div className="stack">
      <div className="row wrap">
        <span className="small muted">
          {dailyReports.length} report(s) · {submittedCount} submitted
        </span>
        <span className="spacer" />
        {canWrite ? (
          <Button size="sm" variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setReportOpen(true)}>
            Daily report
          </Button>
        ) : null}
      </div>

      <Callout tone="blue">
        Submitting a report is what counts toward completion — drafts are saved but never satisfy the
        completion gate. One report per date: saving again updates that day&apos;s report.
      </Callout>

      {dailyReports.length === 0 ? (
        <EmptyState
          title="No daily reports yet"
          icon={<Icon name="file" size={22} />}
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setReportOpen(true)}>
                File today&apos;s report
              </Button>
            ) : null
          }
        >
          The crew records labour, work completed, delays and blockers here each day.
        </EmptyState>
      ) : (
        <div className="list">
          {dailyReports.map((r) => {
            const photos = photoCount(r.photos);
            return (
              <div className="list-item" key={String(r.id)}>
                <div className="row wrap">
                  <span className="strong nowrap">{dateShort(r.report_date)}</span>
                  <Badge tone={REPORT_TONE[String(r.status ?? '')] ?? 'neutral'}>
                    {r.status ? titleCase(String(r.status)) : '—'}
                  </Badge>
                  <span className="spacer" />
                  <span className="tiny muted">
                    {Number(r.labor_hours) || 0} labor hrs · {Number(r.crew_size) || 0} crew
                    {photos !== null ? ` · ${photos} photo(s)` : ''}
                  </span>
                </div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {r.work_completed || '—'}
                </div>
                {r.delays || r.blockers || r.safety_notes ? (
                  <div className="tiny muted" style={{ whiteSpace: 'pre-wrap' }}>
                    {r.delays ? `Delays: ${r.delays}` : ''}
                    {r.delays && r.blockers ? ' · ' : ''}
                    {r.blockers ? `Blockers: ${r.blockers}` : ''}
                    {r.safety_notes ? ` · Safety: ${r.safety_notes}` : ''}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const nameFor = (userId: any): string => {
    if (!userId) return '—';
    const hit = rosterRows.find((r) => r.id === userId);
    return hit ? String(hit.name) : String(userId);
  };

  const renderTasks = () => (
    <div className="stack">
      <div className="row wrap">
        <span className="small muted">{jobTasks.length} task(s) on this job</span>
        <span className="spacer" />
        {can('task.write') ? (
          <Button size="sm" variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setTaskOpen(true)}>
            New task
          </Button>
        ) : null}
      </div>

      {roster.error ? <p className="tiny muted">Roster unavailable: {errMsg(roster.error)}</p> : null}

      {jobTasks.length === 0 ? (
        <EmptyState
          title="No tasks on this job"
          icon={<Icon name="tasks" size={22} />}
          action={
            can('task.write') ? (
              <Button variant="primary" onClick={() => setTaskOpen(true)}>
                New task
              </Button>
            ) : null
          }
        >
          Open tasks must be closed before the job can be marked complete.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Task</th>
                <th>Priority</th>
                <th>Assignee</th>
                <th>Due</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobTasks.map((t) => (
                <tr key={String(t.id)}>
                  <td className="truncate" style={{ maxWidth: 240 }} title={t.title ?? ''}>
                    {t.title || '—'}
                    {t.notes ? <div className="tiny muted truncate">{t.notes}</div> : null}
                  </td>
                  <td>
                    <Badge tone={Number(t.priority) === 1 ? 'red' : 'neutral'}>
                      {Number(t.priority) === 1 ? 'High' : 'Normal'}
                    </Badge>
                  </td>
                  <td className="nowrap">{nameFor(t.assignee_id)}</td>
                  <td className="nowrap">{dateShort(t.due_at)}</td>
                  <td>
                    <Badge tone={t.status === 'done' ? 'green' : t.status === 'cancelled' ? 'outline' : 'blue'}>
                      {t.status ? titleCase(String(t.status)) : '—'}
                    </Badge>
                  </td>
                  <td>
                    {can('task.write') && t.status === 'open' ? (
                      <Button
                        size="sm"
                        variant="success"
                        loading={completingId === String(t.id)}
                        onClick={() => completeTask(t)}
                      >
                        Complete
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderChanges = () => {
    if (!jobChangeOrders.length) {
      return (
        <EmptyState title="No change orders for this job" icon={<Icon name="file" size={22} />}>
          Change orders raised against the project but not linked to this job are listed on the
          project page.
        </EmptyState>
      );
    }
    return (
      <div className="stack">
        {!moneyVisible ? <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout> : null}
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Change order</th>
                <th>Title</th>
                <th>Status</th>
                <th className="num">Internal</th>
                <th className="num">Customer</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {jobChangeOrders.map((co) => (
                <tr key={String(co.id)}>
                  <td className="mono strong nowrap">{co.co_no ?? '—'}</td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={co.title ?? ''}>
                    {co.title || '—'}
                  </td>
                  <td>
                    <Badge tone={CO_TONE[String(co.status ?? '')] ?? 'neutral'}>
                      {co.status ? titleCase(String(co.status)) : '—'}
                    </Badge>
                  </td>
                  <td className="num nowrap">{moneyVisible ? money(co.internal_amount) : '—'}</td>
                  <td className="num nowrap">{moneyVisible ? money(co.customer_amount) : '—'}</td>
                  <td className="nowrap small">{dateShort(co.requested_at ?? co.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTab = () => {
    switch (tab) {
      case 'scope':
        return renderScope();
      case 'costs':
        return renderCosts();
      case 'reports':
        return renderReports();
      case 'tasks':
        return renderTasks();
      case 'changes':
        return renderChanges();
      default:
        return null;
    }
  };

  /* --------------------------- stage control --------------------------- */

  const stepper = (
    <div className="row wrap" style={{ gap: 6 }}>
      {JOB_STAGES.map((s, i) => {
        const reached = idx < 0 ? false : i <= idx;
        const current = s === stage;
        return (
          <Fragment key={s}>
            {i > 0 ? (
              <span className="muted tiny" aria-hidden="true">
                →
              </span>
            ) : null}
            <Badge tone={current ? 'accent' : reached ? 'green' : 'outline'}>
              {reached ? <Icon name="check" size={12} /> : null}
              {stageLabel(s)}
            </Badge>
          </Fragment>
        );
      })}
    </div>
  );

  const stageControls = (
    <div className="row wrap">
      {next ? (
        <Button variant="primary" size="sm" disabled={!canWrite} onClick={() => openAdvance(next)}>
          Move to {stageLabel(next)}
        </Button>
      ) : (
        <span className="small muted">Final stage — this job is closed out.</span>
      )}
      {back ? (
        <Button
          size="sm"
          disabled={!canWrite}
          title={canWrite ? undefined : 'Moving stages requires production.write.'}
          onClick={() => openAdvance(back)}
        >
          Move back to {stageLabel(back)}
        </Button>
      ) : null}
    </div>
  );

  /* ------------------------------ rail ------------------------------ */

  const rail = (
    <aside className="stack">
      <Card title="Stage" sub="Server-validated pipeline" actions={stageControls}>
        <KeyValue
          items={[
            ['Current stage', <Badge tone={STAGE_TONE[stage] ?? 'neutral'}>{stageLabel(stage)}</Badge>],
            ['Entered', dateShort(job.stage_entered_at)],
            ['Days in stage', stageDays !== null ? `${stageDays}d` : '—'],
            ['Job', <span className="mono">{job.job_no ?? '—'}</span>],
          ]}
        />
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Every move is re-checked by the server; blockers appear in the confirm dialog.
        </div>
      </Card>

      <Card title="Daily report status">
        <KeyValue
          items={[
            [
              'Report today',
              reportToday ? (
                <Badge tone={REPORT_TONE[String(reportToday.status ?? '')] ?? 'neutral'}>
                  {reportToday.status ? titleCase(String(reportToday.status)) : '—'}
                </Badge>
              ) : (
                <span className="muted">None yet</span>
              ),
            ],
            ['Submitted reports', `${submittedCount} of ${dailyReports.length}`],
            ['Last report', dailyReports[0] ? dateShort(dailyReports[0].report_date) : '—'],
          ]}
        />
        {canWrite ? (
          <div style={{ marginTop: 10 }}>
            <Button size="sm" block onClick={() => setReportOpen(true)}>
              {reportToday ? 'Update today’s report' : 'File today’s report'}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card title="Cost summary">
        {!moneyVisible ? (
          <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>
        ) : (
          <KeyValue
            items={[
              ['Estimated', money(job.estimated_cost)],
              ['Committed', money(committed)],
              ['Actual', money(actual)],
              ['Variance', money(actual - Number(job.estimated_cost || 0))],
            ]}
          />
        )}
      </Card>
    </aside>
  );

  /* ------------------------------ page ------------------------------ */

  return (
    <div className="stack">
      <PageHead
        title={<span className="mono">{String(job.job_no ?? 'Job')}</span>}
        sub={
          <span>
            {job.name || (trade ? TRADE_LABELS[trade] ?? titleCase(trade) : 'Untitled job')}
            {projectName && projectName !== '—' ? ` · ${projectName}` : ''}
          </span>
        }
        actions={
          <div className="row wrap">
            <LinkButton to={`/projects/${projectId}`} size="sm">
              ← Project
            </LinkButton>
            <LinkButton to="/production" size="sm">
              Production
            </LinkButton>
          </div>
        }
      >
        <div className="row wrap">
          <Badge tone="blue">{trade ? (TRADE_LABELS[trade] ?? titleCase(trade)) : '—'}</Badge>
          <Badge tone={STAGE_TONE[stage] ?? 'neutral'}>{stageLabel(stage)}</Badge>
          <Badge tone="outline">{stageDays !== null ? `${stageDays}d in stage` : '—'}</Badge>
          {projectName && projectName !== '—' ? <span className="small muted">{projectName}</span> : null}
        </div>
      </PageHead>

      {jobRes.error ? <ErrorState error={jobRes.error} onRetry={jobRes.reload} /> : null}

      <Card title="Stage pipeline" sub="Unscheduled → paid">
        <div className="stack">
          {stepper}
          {stageControls}
          <Callout tone="blue">
            <b>Enforced by the server before a job can be marked complete:</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Daily reports are submitted for this job.</li>
              <li>No open blockers (high-priority tasks) remain.</li>
              <li>No open tasks remain.</li>
              <li>Completion is authorized by a project manager.</li>
            </ul>
          </Callout>
        </div>
      </Card>

      <div className="split-wide">
        <div className="stack">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          <Card>{renderTab()}</Card>
        </div>
        {rail}
      </div>

      {advanceTo ? (
        <ConfirmDialog
          title={`Move to ${stageLabel(advanceTo)}`}
          message={
            <div className="stack" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>
                <b>{job.job_no}</b> moves from <b>{stageLabel(stage)}</b> to{' '}
                <b>{stageLabel(advanceTo)}</b>.
              </p>
              <div className="tiny muted strong">THE SERVER CHECKS THESE REQUIREMENTS</div>
              <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
                {requirementsFor(advanceTo).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          }
          confirmLabel={`Move to ${stageLabel(advanceTo)}`}
          tone="primary"
          loading={advancing}
          onConfirm={doAdvance}
          onCancel={() => {
            setAdvanceTo(null);
            setAdvanceErr(null);
            setAuthChecked(false);
          }}
        >
          {advanceTo === 'complete' ? (
            canAuthorize ? (
              <Checkbox
                label="I authorize completion"
                hint="Confirming tells the server this job is finished and may leave the punch list. Project Managers and holders of production.financials authorize completion."
                checked={authChecked}
                onChange={(e) => setAuthChecked(e.target.checked)}
              />
            ) : (
              <Callout tone="grey">
                Completion must be authorized by a project manager — ask one to authorize before
                moving this job to complete.
              </Callout>
            )
          ) : null}

          {advanceErr ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="warn-state" role="alert">
                {advanceErr.message}
              </div>
              {advanceErr.status === 409 && advanceErr.blockers.length ? (
                <BlockerList items={advanceErr.blockers.map((b) => ({ label: b.label, detail: b.detail }))} />
              ) : null}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {costModal ? (
        <CostModal
          jobId={String(job.id)}
          categories={categories}
          editing={costModal.row}
          onClose={() => setCostModal(null)}
          onSaved={() => {
            setCostModal(null);
            reloadAll();
          }}
        />
      ) : null}

      {deleteCost ? (
        <ConfirmDialog
          title="Delete cost record"
          message={
            <>
              Remove the {deleteCost.kind ? titleCase(String(deleteCost.kind)) : ''} cost of{' '}
              <strong>{money(deleteCost.amount)}</strong>
              {deleteCost.description ? ` (${deleteCost.description})` : ''}? This cannot be undone.
            </>
          }
          confirmLabel="Delete cost"
          loading={deletingCost}
          onConfirm={removeCost}
          onCancel={() => {
            setDeleteCost(null);
            setDeleteCostErr(null);
          }}
        >
          {deleteCostErr ? (
            <div className="warn-state" role="alert">
              {deleteCostErr.message}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {reportOpen ? (
        <DailyReportModal
          jobId={String(job.id)}
          reports={dailyReports}
          onClose={() => setReportOpen(false)}
          onSaved={(status) => {
            setReportOpen(false);
            toast.success(
              status === 'submitted' ? 'Daily report submitted' : 'Daily report saved',
              status === 'submitted' ? 'It now counts toward completion.' : 'Draft — submit it to count toward completion.',
            );
            jobRes.reload();
          }}
        />
      ) : null}

      {taskOpen ? (
        <NewTaskModal
          jobId={String(job.id)}
          projectId={projectId}
          roster={rosterRows}
          onClose={() => setTaskOpen(false)}
          onSaved={() => {
            setTaskOpen(false);
            jobRes.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Record / edit cost                                                  */
/* ================================================================== */

function CostModal({
  jobId,
  categories,
  editing,
  onClose,
  onSaved,
}: {
  jobId: string;
  categories: any[];
  editing?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!editing?.id;
  const [categoryId, setCategoryId] = useState(String(editing?.category_id ?? ''));
  const [kind, setKind] = useState<'committed' | 'actual'>(editing?.kind === 'committed' ? 'committed' : 'actual');
  const [description, setDescription] = useState(String(editing?.description ?? ''));
  const [amount, setAmount] = useState(editing?.amount == null ? '' : String(editing.amount));
  const [occurredAt, setOccurredAt] = useState(
    editing?.occurred_at ? dayInput(editing.occurred_at) : todayInput(),
  );
  const [source, setSource] = useState(String(editing?.source ?? 'manual'));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const amountNum = Number(amount);
  const amountOk = amount !== '' && Number.isFinite(amountNum) && amountNum > 0;

  const submit = async () => {
    if (!categoryId || !amountOk) return;
    setPending(true);
    setErr(null);
    const body: Record<string, unknown> = {
      categoryId,
      kind,
      description: description.trim(),
      amount: amountNum,
      occurredAt: dateToMs(occurredAt),
      source,
    };
    try {
      if (isEdit) {
        await patch(`/jobs/costs/${editing.id}`, body);
        toast.success('Cost updated', `${money(amountNum)} ${kind}.`);
      } else {
        await post('/jobs/costs', { ...body, jobId });
        toast.success('Cost recorded', `${money(amountNum)} ${kind}.`);
      }
      onSaved();
    } catch (e) {
      // 422 for a non-positive amount (and any other validation) stays in the dialog.
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit cost' : 'Record cost'}
      sub="Committed = a promise to pay. Actual = expensed."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={pending}
            disabled={!categoryId || !amountOk}
          >
            {isEdit ? 'Save cost' : 'Record cost'}
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

        <div className="field">
          <label>
            Kind<span className="req">*</span>
          </label>
          <Segmented<'committed' | 'actual'>
            options={[
              { value: 'committed', label: 'Committed' },
              { value: 'actual', label: 'Actual' },
            ]}
            value={kind}
            onChange={setKind}
          />
        </div>

        <div className="form-grid">
          <Select
            label="Category"
            required
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            placeholder="Select a category"
            error={err?.fieldErrors?.categoryId}
            options={categories.map((c) => ({ value: String(c.id), label: String(c.name ?? c.key) }))}
          />
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
              (amount !== '' && !amountOk ? 'Amount must be greater than zero.' : undefined)
            }
          />
          <Input
            label="Occurred"
            type="date"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            error={err?.fieldErrors?.occurredAt}
          />
          <Select
            label="Source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            error={err?.fieldErrors?.source}
            options={[
              { value: 'manual', label: 'Manual' },
              { value: 'po', label: 'Purchase order' },
              { value: 'invoice', label: 'Invoice' },
              { value: 'change_order', label: 'Change order' },
            ]}
          />
        </div>

        <TextArea
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={err?.fieldErrors?.description}
          placeholder="What the money is for"
        />
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Daily report (upsert per date)                                      */
/* ================================================================== */

function DailyReportModal({
  jobId,
  reports,
  onClose,
  onSaved,
}: {
  jobId: string;
  reports: any[];
  onClose: () => void;
  onSaved: (status: string) => void;
}) {
  const first = findReport(reports, todayInput());
  const [date, setDate] = useState(todayInput());
  const [workCompleted, setWorkCompleted] = useState(String(first?.work_completed ?? ''));
  const [laborHours, setLaborHours] = useState(first?.labor_hours == null ? '' : String(first.labor_hours));
  const [crewSize, setCrewSize] = useState(first?.crew_size == null ? '' : String(first.crew_size));
  const [materialsUsed, setMaterialsUsed] = useState(String(first?.materials_used ?? ''));
  const [equipmentUsed, setEquipmentUsed] = useState(String(first?.equipment_used ?? ''));
  const [safetyNotes, setSafetyNotes] = useState(String(first?.safety_notes ?? ''));
  const [delays, setDelays] = useState(String(first?.delays ?? ''));
  const [blockers, setBlockers] = useState(String(first?.blockers ?? ''));
  const [status, setStatus] = useState<'draft' | 'submitted'>(first?.status === 'submitted' ? 'submitted' : 'draft');
  const [customerCommCheck, setCustomerCommCheck] = useState(first?.customer_comm_check === 1);
  const [photos, setPhotos] = useState<string[]>(() => {
    const parsed = first?.photos;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string' && parsed.trim()) {
      try {
        const p = JSON.parse(parsed);
        return Array.isArray(p) ? p : [];
      } catch {
        return [];
      }
    }
    return [];
  });
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const reportMs = dateToMs(date);

  // Switching dates re-seeds from that day's report so an update never wipes it.
  const onDateChange = (v: string) => {
    setDate(v);
    const r = findReport(reports, v);
    setWorkCompleted(String(r?.work_completed ?? ''));
    setLaborHours(r?.labor_hours == null ? '' : String(r.labor_hours));
    setCrewSize(r?.crew_size == null ? '' : String(r.crew_size));
    setMaterialsUsed(String(r?.materials_used ?? ''));
    setEquipmentUsed(String(r?.equipment_used ?? ''));
    setSafetyNotes(String(r?.safety_notes ?? ''));
    setDelays(String(r?.delays ?? ''));
    setBlockers(String(r?.blockers ?? ''));
    setStatus(r?.status === 'submitted' || r?.status === 'approved' ? 'submitted' : 'draft');
    setCustomerCommCheck(r?.customer_comm_check === 1);
    const parsed = r?.photos;
    if (Array.isArray(parsed)) setPhotos(parsed);
    else if (typeof parsed === 'string' && parsed.trim()) {
      try {
        const p = JSON.parse(parsed);
        setPhotos(Array.isArray(p) ? p : []);
      } catch {
        setPhotos([]);
      }
    } else setPhotos([]);
    setErr(null);
  };

  const submit = async () => {
    if (!reportMs) return;
    setPending(true);
    setErr(null);
    try {
      await post(`/jobs/${jobId}/daily-report`, {
        reportDate: reportMs,
        workCompleted: workCompleted.trim(),
        laborHours: laborHours === '' ? 0 : Number(laborHours),
        crewSize: crewSize === '' ? 0 : Number(crewSize),
        materialsUsed: materialsUsed.trim(),
        equipmentUsed: equipmentUsed.trim(),
        safetyNotes: safetyNotes.trim(),
        delays: delays.trim(),
        blockers: blockers.trim(),
        photos,
        customerCommCheck,
        status,
      });
      onSaved(status);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Daily report"
      sub="One report per date — saving again updates that day."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!reportMs}>
            {status === 'submitted' ? 'Submit report' : 'Save draft'}
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
            label="Report date"
            required
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            error={err?.fieldErrors?.reportDate}
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value === 'submitted' ? 'submitted' : 'draft')}
            error={err?.fieldErrors?.status}
            hint="Only submitted reports count toward completion."
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'submitted', label: 'Submitted' },
            ]}
          />
          <Input
            label="Labor hours"
            type="number"
            min="0"
            step="any"
            value={laborHours}
            onChange={(e) => setLaborHours(e.target.value)}
            error={err?.fieldErrors?.laborHours}
          />
          <Input
            label="Crew size"
            type="number"
            min="0"
            step="1"
            value={crewSize}
            onChange={(e) => setCrewSize(e.target.value)}
            error={err?.fieldErrors?.crewSize}
          />
        </div>

        <TextArea
          label="Work completed"
          rows={3}
          value={workCompleted}
          onChange={(e) => setWorkCompleted(e.target.value)}
          error={err?.fieldErrors?.workCompleted}
        />
        <div className="form-grid">
          <TextArea
            label="Materials used"
            rows={2}
            value={materialsUsed}
            onChange={(e) => setMaterialsUsed(e.target.value)}
            error={err?.fieldErrors?.materialsUsed}
          />
          <TextArea
            label="Equipment used"
            rows={2}
            value={equipmentUsed}
            onChange={(e) => setEquipmentUsed(e.target.value)}
            error={err?.fieldErrors?.equipmentUsed}
          />
          <TextArea
            label="Delays"
            rows={2}
            value={delays}
            onChange={(e) => setDelays(e.target.value)}
            error={err?.fieldErrors?.delays}
          />
          <TextArea
            label="Blockers"
            rows={2}
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            error={err?.fieldErrors?.blockers}
          />
        </div>
        <TextArea
          label="Safety notes"
          rows={2}
          value={safetyNotes}
          onChange={(e) => setSafetyNotes(e.target.value)}
          error={err?.fieldErrors?.safetyNotes}
        />

        <Checkbox
          label="Customer communication confirmed"
          checked={customerCommCheck}
          onChange={(e) => setCustomerCommCheck(e.target.checked)}
        />

        <Callout tone="grey">
          Submitting is what counts toward completion — a draft satisfies no gate. Photos already
          filed for this date are kept as-is ({photos.length} on file).
        </Callout>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* New task                                                            */
/* ================================================================== */

function NewTaskModal({
  jobId,
  projectId,
  roster,
  onClose,
  onSaved,
}: {
  jobId: string;
  projectId: string;
  roster: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState(todayInput());
  const [type, setType] = useState('task');
  const [notes, setNotes] = useState('');
  const [highPriority, setHighPriority] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const dueMs = dateToMs(dueAt);
  const valid = !!title.trim() && !!assigneeId && !!dueMs;

  const submit = async () => {
    if (!valid || !dueMs) return;
    setPending(true);
    setErr(null);
    try {
      await post('/tasks', {
        title: title.trim(),
        notes: notes.trim(),
        type,
        assigneeId,
        dueAt: dueMs,
        priority: highPriority ? 1 : 0,
        jobId,
        projectId: projectId || null,
      });
      toast.success('Task created', title.trim());
      onSaved();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="New task"
      sub="Open tasks must be closed before this job can be completed."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!valid}>
            Create task
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? <div className="error-state" role="alert">{err.message}</div> : null}
        <Input
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={err?.fieldErrors?.title}
          placeholder="e.g. Replace damaged flashing"
        />
        <div className="form-grid">
          <Select
            label="Assignee"
            required
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            placeholder="Select a person"
            error={err?.fieldErrors?.assigneeId}
            options={roster.map((r) => ({ value: String(r.id), label: String(r.name) }))}
          />
          <Input
            label="Due"
            required
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            error={err?.fieldErrors?.dueAt}
          />
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            error={err?.fieldErrors?.type}
            options={TASK_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
          />
        </div>
        <TextArea
          label="Notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={err?.fieldErrors?.notes}
        />
        <Checkbox
          label="High priority"
          hint="High-priority open tasks count as blockers on the completion gate."
          checked={highPriority}
          onChange={(e) => setHighPriority(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
