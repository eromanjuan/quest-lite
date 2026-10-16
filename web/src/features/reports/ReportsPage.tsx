import { useState, type ReactNode } from 'react';
import { ApiError, qs } from '../../lib/api';
import { useFetch } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Input,
  KeyValue,
  Loading,
  Meter,
  PageHead,
  Segmented,
  Stat,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { date, money, money2, num, pct, pctRaw, stageLabel, titleCase } from '../../lib/format';

type Scope = 'prospecting' | 'underwriting' | 'sales' | 'production';
type Period = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;

const SCOPE_OPTIONS: Array<{ value: Scope; label: string }> = [
  { value: 'prospecting', label: 'Prospecting' },
  { value: 'underwriting', label: 'Underwriting' },
  { value: 'sales', label: 'Sales' },
  { value: 'production', label: 'Production' },
];
const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

interface FunnelStep {
  key: string;
  label: string;
  count: number;
  value: number | null;
  conversionFromPrevious: number | null;
  conversionPct: number | null;
}

interface AgingRow {
  workspace: string;
  stage: string;
  count: number;
  avgAgeDays: number;
  overLimit: boolean;
  limit?: number;
}

/** Human labels for every field each /dashboard/kpis scope can return. */
const LABELS: Record<string, string> = {
  outboundDials: 'Outbound dials',
  connectedCalls: 'Connected calls',
  leadsGenerated: 'Leads generated',
  callsPerLead: 'Calls per lead',
  followUpsCompleted: 'Follow-ups completed',
  followUpsOverdue: 'Follow-ups overdue',
  leadsBySource: 'Leads by source',
  leadsByTerritory: 'Leads by territory',
  leadsConvertedToQuoteRequests: 'Leads converted to quote requests',
  conversionRateByStage: 'Prospect mix by stage',
  bidsReceived: 'Bids received',
  quotesCompleted: 'Quotes completed',
  leadToQuoteConversion: 'Bid → quote conversion',
  averageTurnaroundHours: 'Average turnaround (hours)',
  averageBidAgeDays: 'Average open bid age (days)',
  overdueBids: 'Overdue bids',
  quotesByEstimator: 'Quotes by estimator',
  revisions: 'Estimate revisions (beyond v1)',
  marginExceptions: 'Margin exceptions approved',
  quotesSubmittedCount: 'Quotes submitted (count)',
  quotesSubmittedValue: 'Quotes submitted (value)',
  byDeliveryMethod: 'Proposals by delivery method',
  negotiating: 'Deals negotiating now',
  contractsSent: 'Contracts sent',
  won: 'Deals won',
  lost: 'Deals lost',
  closeRate: 'Close rate (won ÷ won+lost)',
  averageDealValue: 'Average deal value',
  timeInStage: 'Average days in stage (deals, from audit trail)',
  lostReasons: 'Lost reasons',
  avgDaysToClose: 'Average days to close',
  jobsStarted: 'Jobs started',
  jobsCompleted: 'Jobs completed',
  avgDaysPerStage: 'Average days in current stage (jobs)',
  scheduleAdherence: 'Schedule adherence',
  estimatedVsActual: 'Estimated vs actual cost',
  changeOrders: 'Change orders',
  drawsBilled: 'Draws billed',
  drawsCollected: 'Draws collected',
  outstandingReceivables: 'Outstanding receivables',
  dailyReportsSubmitted: 'Daily reports submitted',
  openBlockers: 'Open blockers (priority 1)',
  costOverruns: 'Projects over estimated cost',
  financialsRestricted: 'Financial figures restricted for your role',
};

/** Four headline Stats per scope for the grid grid-4. */
const HEADLINES: Record<Scope, string[]> = {
  prospecting: ['outboundDials', 'connectedCalls', 'leadsGenerated', 'callsPerLead'],
  underwriting: ['bidsReceived', 'quotesCompleted', 'averageTurnaroundHours', 'overdueBids'],
  sales: ['won', 'lost', 'closeRate', 'averageDealValue'],
  production: ['jobsStarted', 'jobsCompleted', 'openBlockers', 'scheduleAdherence'],
};

const MONEY_KEYS = new Set([
  'quotesSubmittedValue',
  'averageDealValue',
  'drawsBilled',
  'drawsCollected',
  'outstandingReceivables',
]);
const RATIO_KEYS = new Set(['closeRate', 'leadToQuoteConversion']); // server returns 0..1
const RAW_PCT_KEYS = new Set(['scheduleAdherence']); // server returns an already-scaled percent
const ONE_DP_KEYS = new Set(['callsPerLead', 'averageTurnaroundHours', 'averageBidAgeDays', 'avgDaysToClose']);

function is403(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** null → em dash. No value is ever derived or rounded into existence. */
function renderScalar(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return '—';
  if (MONEY_KEYS.has(key)) return typeof value === 'number' ? money2(value) : String(value);
  if (RATIO_KEYS.has(key)) return typeof value === 'number' ? pct(value) : String(value);
  if (RAW_PCT_KEYS.has(key)) return typeof value === 'number' ? pctRaw(value) : String(value);
  if (typeof value === 'number') return num(value, ONE_DP_KEYS.has(key) ? 1 : 2);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const reason = (value as Record<string, unknown>).reason;
    if (typeof reason === 'string') return <span className="tiny muted">{reason}</span>;
    return JSON.stringify(value);
  }
  return String(value);
}

interface TableSpec {
  labelOf: (r: any) => string;
  valueOf: (r: any) => number | null;
  fmt: 'num' | 'num1';
  extraOf?: (r: any) => ReactNode;
  extraHeader?: string;
}

const TABLES: Record<string, TableSpec> = {
  leadsBySource: { labelOf: (r) => String(r.name ?? '—'), valueOf: (r) => r.count, fmt: 'num' },
  leadsByTerritory: { labelOf: (r) => String(r.name ?? '—'), valueOf: (r) => r.count, fmt: 'num' },
  quotesByEstimator: { labelOf: (r) => String(r.name ?? '—'), valueOf: (r) => r.count, fmt: 'num' },
  lostReasons: { labelOf: (r) => String(r.reason ?? '—'), valueOf: (r) => r.count, fmt: 'num' },
  byDeliveryMethod: { labelOf: (r) => titleCase(String(r.method ?? '—')), valueOf: (r) => r.count, fmt: 'num' },
  conversionRateByStage: {
    labelOf: (r) => stageLabel(String(r.stage ?? '—')),
    valueOf: (r) => r.count,
    fmt: 'num',
    extraOf: (r) => pctRaw(r.pct),
    extraHeader: 'Share',
  },
  avgDaysPerStage: { labelOf: (r) => stageLabel(String(r.stage ?? '—')), valueOf: (r) => r.avgDays, fmt: 'num1' },
  timeInStage: { labelOf: (r) => stageLabel(String(r.stage ?? '—')), valueOf: (r) => r.avgDays, fmt: 'num1' },
};

function fmtByKind(v: number | null | undefined, fmt: 'num' | 'num1'): string {
  if (v === null || v === undefined) return '—';
  return fmt === 'num1' ? num(v, 1) : num(v);
}

/** Label / value / bar scaled to the largest value in this table only. */
function BarTable({ rows, spec }: { rows: any[]; spec: TableSpec }) {
  if (!rows.length) return <div className="muted small">No rows in this window — nothing to chart.</div>;
  const values = rows.map((r) => Number(spec.valueOf(r) ?? 0));
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Label</th>
            <th className="num">Value</th>
            {spec.extraHeader ? <th className="num">{spec.extraHeader}</th> : null}
            <th>Relative</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const v = spec.valueOf(r);
            return (
              <tr key={i}>
                <td className="truncate" title={spec.labelOf(r)}>
                  {spec.labelOf(r)}
                </td>
                <td className="num">{fmtByKind(v, spec.fmt)}</td>
                {spec.extraHeader ? <td className="num">{spec.extraOf ? spec.extraOf(r) : '—'}</td> : null}
                <td style={{ minWidth: 140 }}>
                  <Meter value={max > 0 ? (Number(v ?? 0) / max) * 100 : 0} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EstimatedVsActualBlock({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object') {
    // The server nulls this when the caller lacks production.financials.
    return <span className="muted">—</span>;
  }
  const d = data as {
    estimated?: number | null;
    actual?: number | null;
    variance?: number | null;
    variancePct?: number | null;
  };
  const max = Math.max(Number(d.estimated ?? 0), Number(d.actual ?? 0), 0);
  const row = (label: string, v: number | null | undefined) => (
    <div className="row" style={{ gap: 10 }}>
      <span className="small" style={{ width: 90 }}>
        {label}
      </span>
      <span className="num" style={{ width: 110 }}>
        {v === null || v === undefined ? '—' : money2(v)}
      </span>
      <span className="grow">
        <Meter value={max > 0 ? (Number(v ?? 0) / max) * 100 : 0} tone={label === 'Actual' ? 'warn' : undefined} />
      </span>
    </div>
  );
  return (
    <div className="col" style={{ gap: 8 }}>
      {row('Estimated', d.estimated)}
      {row('Actual', d.actual)}
      <div className="tiny muted">
        Variance {d.variance === null || d.variance === undefined ? '—' : money2(d.variance)} ·{' '}
        {d.variancePct === null || d.variancePct === undefined ? '—' : pctRaw(d.variancePct)} (positive = under
        budget)
      </div>
    </div>
  );
}

type Block =
  | { kind: 'kv'; id: string; items: Array<[ReactNode, ReactNode]> }
  | { kind: 'node'; id: string; label: string; node: ReactNode };

/** Walks the response in server order: scalars batch into KeyValue blocks, structured values get their own card. */
function buildBlocks(data: Record<string, unknown>): Block[] {
  const blocks: Block[] = [];
  let kv: Array<[ReactNode, ReactNode]> = [];
  const flush = () => {
    if (kv.length) {
      blocks.push({ kind: 'kv', id: `kv-${blocks.length}`, items: kv });
      kv = [];
    }
  };
  for (const [key, value] of Object.entries(data)) {
    const label = LABELS[key] ?? titleCase(key);
    if (key === 'estimatedVsActual') {
      flush();
      blocks.push({ kind: 'node', id: key, label, node: <EstimatedVsActualBlock data={value} /> });
      continue;
    }
    if (key === 'changeOrders' && value && typeof value === 'object') {
      flush();
      const co = value as {
        requested?: number | null;
        approved?: number | null;
        authorized?: number | null;
        value?: number | null;
      };
      blocks.push({
        kind: 'node',
        id: key,
        label,
        node: (
          <KeyValue
            items={[
              ['Requested', num(co.requested ?? null)],
              ['Approved', num(co.approved ?? null)],
              ['Authorized', num(co.authorized ?? null)],
              ['Value', money2(co.value ?? null)],
            ]}
          />
        ),
      });
      continue;
    }
    const spec = TABLES[key];
    if (spec && Array.isArray(value)) {
      flush();
      blocks.push({ kind: 'node', id: key, label, node: <BarTable rows={value} spec={spec} /> });
      continue;
    }
    kv.push([label, renderScalar(key, value)]);
  }
  flush();
  return blocks;
}

function PermissionCallout({ permission, what }: { permission: string; what: string }) {
  return (
    <Callout tone="grey">
      {what} requires the <b>{permission}</b> permission, which your role does not have. The server refuses
      these requests, so the section explains the gate instead of showing an error.
    </Callout>
  );
}

/** 'YYYY-MM-DD' → epoch ms of local start (or end) of that day. */
function dayStart(v: string): number | null {
  if (!v) return null;
  const parts = v.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
}
function dayEnd(v: string): number | null {
  const s = dayStart(v);
  return s === null ? null : s + DAY_MS - 1;
}

export default function ReportsPage() {
  const { can } = useAuth();
  const [scope, setScope] = useState<Scope>('prospecting');
  const [period, setPeriod] = useState<Period>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const canKpi = can('kpi.view');
  const fromMs = dayStart(from);
  const toMs = dayEnd(to);
  const customWindow = fromMs !== null || toMs !== null;

  const kpis = useFetch<Record<string, unknown>>(
    canKpi ? `/dashboard/kpis?${qs({ scope, period, from: fromMs, to: toMs })}` : null,
    [canKpi, scope, period, from, to],
  );
  const funnel = useFetch<{ steps: FunnelStep[] }>(canKpi ? '/dashboard/funnel' : null, [canKpi]);
  const aging = useFetch<unknown>(canKpi ? '/dashboard/aging' : null, [canKpi]);

  // The endpoint may return {rows} or a bare array — accept both.
  const agingRows: AgingRow[] = Array.isArray(aging.data)
    ? (aging.data as AgingRow[])
    : ((aging.data as { rows?: AgingRow[] } | null)?.rows ?? []);

  const data = kpis.data;
  const blocks = data ? buildBlocks(data) : [];

  let kpiBody: ReactNode;
  if (!canKpi) {
    kpiBody = <PermissionCallout permission="kpi.view" what="Company KPI reporting" />;
  } else if (kpis.error && is403(kpis.error) && !data) {
    kpiBody = <PermissionCallout permission="kpi.view" what="Company KPI reporting" />;
  } else if (kpis.error && !data) {
    kpiBody = <ErrorState error={kpis.error} onRetry={kpis.reload} />;
  } else if (kpis.loading && !data) {
    kpiBody = <Loading label="Loading metrics…" />;
  } else {
    kpiBody = (
      <>
        <div className="grid grid-4" style={{ marginBottom: 14 }}>
          {HEADLINES[scope].map((key) => (
            <Stat key={key} label={LABELS[key] ?? titleCase(key)} value={renderScalar(key, data ? data[key] : null)} />
          ))}
        </div>
        <div className="stack">
          {blocks.map((b) =>
            b.kind === 'kv' ? (
              <div className="card card-pad" key={b.id}>
                <KeyValue items={b.items} />
              </div>
            ) : (
              <Card title={b.label} key={b.id}>
                {b.node}
              </Card>
            ),
          )}
        </div>
        {data && data.financialsRestricted === true ? (
          <div style={{ marginTop: 12 }}>
            <Callout tone="grey">
              Dollar figures are shown as — because your role lacks <b>production.financials</b>. The server
              nulls them rather than leaking them to the client.
            </Callout>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Reports"
        sub={`${titleCase(scope)} · ${customWindow ? `${from ? date(fromMs) : 'start'} → ${to ? date(toMs) : 'now'}` : `last ${period}`}`}
      />

      <div style={{ marginBottom: 14 }}>
        <Callout tone="grey">
          Every figure below is computed from live records in this database. Metrics the server cannot derive
          are returned as null and shown as —, never estimated.
        </Callout>
      </div>

      <div className="filters">
        <Segmented options={SCOPE_OPTIONS} value={scope} onChange={setScope} />
        <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
        <span className="tiny muted">From</span>
        <Input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="tiny muted">To</span>
        <Input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        {from || to ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            Clear dates
          </Button>
        ) : null}
        <span className="tiny muted">{customWindow ? 'Custom window overrides the period.' : ''}</span>
      </div>

      {kpiBody}

      <div style={{ marginTop: 14 }}>
        <Card title="Business funnel" sub="Company-wide conversion ladder computed from live rows.">
          {!canKpi ? (
            <PermissionCallout permission="kpi.view" what="The business funnel" />
          ) : funnel.error && is403(funnel.error) && !funnel.data ? (
            <PermissionCallout permission="kpi.view" what="The business funnel" />
          ) : funnel.error && !funnel.data ? (
            <ErrorState error={funnel.error} onRetry={funnel.reload} />
          ) : funnel.loading && !funnel.data ? (
            <Loading label="Loading funnel…" />
          ) : (funnel.data?.steps ?? []).length === 0 ? (
            <EmptyState title="No funnel steps returned." icon={<Icon name="reports" size={22} />}>
              Nothing matched this window.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th className="num">Count</th>
                    <th className="num">Value</th>
                    <th className="num">From previous</th>
                  </tr>
                </thead>
                <tbody>
                  {(funnel.data?.steps ?? []).map((s) => (
                    <tr key={s.key}>
                      <td className="strong">{s.label}</td>
                      <td className="num">{num(s.count)}</td>
                      <td className="num">{s.value === null || s.value === undefined ? '—' : money(s.value)}</td>
                      <td className="num">
                        {s.conversionPct === null || s.conversionPct === undefined
                          ? '—'
                          : pctRaw(s.conversionPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card
          title="Stage aging"
          sub="Average days records have sat in their current stage, against the configured limits."
        >
          {!canKpi ? (
            <PermissionCallout permission="kpi.view" what="Stage aging" />
          ) : aging.error && is403(aging.error) && !aging.data ? (
            <PermissionCallout permission="kpi.view" what="Stage aging" />
          ) : aging.error && !aging.data ? (
            <ErrorState error={aging.error} onRetry={aging.reload} />
          ) : aging.loading && !aging.data ? (
            <Loading label="Loading aging…" />
          ) : agingRows.length === 0 ? (
            <EmptyState title="No aging rows." icon={<Icon name="clock" size={22} />}>
              No open records are aging right now.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Stage</th>
                    <th className="num">Records</th>
                    <th className="num">Avg age (days)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {agingRows.map((r, i) => (
                    <tr key={`${r.workspace}-${r.stage}-${i}`}>
                      <td>{titleCase(r.workspace)}</td>
                      <td className="strong">{stageLabel(r.stage)}</td>
                      <td className="num">{num(r.count)}</td>
                      <td className="num">{num(r.avgAgeDays, 1)}</td>
                      <td>
                        {r.overLimit ? (
                          <Badge tone="red">
                            Over limit{typeof r.limit === 'number' ? ` (${num(r.limit)} d)` : ''}
                          </Badge>
                        ) : (
                          <Badge tone="green">Within limit</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
