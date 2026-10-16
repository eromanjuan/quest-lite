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
  KeyValue,
  LinkButton,
  Loading,
  Meter,
  PageHead,
  Segmented,
  Stat,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { date, money, money2, num, pct, pctRaw, rel, titleCase } from '../../lib/format';

type Period = 'day' | 'week' | 'month';
type Scope = 'prospecting' | 'underwriting' | 'sales' | 'production';
type Severity = 'critical' | 'warning' | 'info';

const PERIOD_OPTIONS: Array<{ value: Period; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
const SEVERITY_TONE: Record<Severity, 'red' | 'amber' | 'blue'> = {
  critical: 'red',
  warning: 'amber',
  info: 'blue',
};

const SCOPE_ORDER: Scope[] = ['prospecting', 'underwriting', 'sales', 'production'];
const SCOPE_LABELS: Record<Scope, string> = {
  prospecting: 'Prospecting',
  underwriting: 'Underwriting',
  sales: 'Sales',
  production: 'Production',
};

interface AttentionItem {
  severity: Severity;
  kind: string;
  title: string;
  detail: string;
  link?: string | null;
}

interface TodayResponse {
  needsAttention: AttentionItem[];
  counts: {
    runningToday?: number;
    scheduledTomorrow?: number;
    onHold?: number;
    dailyReports?: number;
    owingDailyReport?: number;
  };
}

interface FunnelStep {
  key: string;
  label: string;
  count: number;
  value: number | null;
  conversionFromPrevious: number | null;
  conversionPct: number | null;
}

interface TaskRow {
  id: string;
  title: string;
  type?: string | null;
  priority?: number | null;
  due_at?: number | null;
}

type Fmt = 'num' | 'num1' | 'money2' | 'pct';

/** Headline metrics per KPI scope — field names mirror server/routes/dashboard.ts exactly. */
const HEADLINE: Record<Scope, Array<{ key: string; label: string; fmt: Fmt }>> = {
  prospecting: [
    { key: 'outboundDials', label: 'Outbound dials', fmt: 'num' },
    { key: 'connectedCalls', label: 'Connected calls', fmt: 'num' },
    { key: 'callsPerLead', label: 'Calls per lead', fmt: 'num1' },
  ],
  underwriting: [
    { key: 'bidsReceived', label: 'Bids received', fmt: 'num' },
    { key: 'quotesCompleted', label: 'Quotes completed', fmt: 'num' },
    { key: 'averageTurnaroundHours', label: 'Avg turnaround (h)', fmt: 'num1' },
  ],
  sales: [
    { key: 'won', label: 'Won deals', fmt: 'num' },
    { key: 'closeRate', label: 'Close rate', fmt: 'pct' },
    { key: 'averageDealValue', label: 'Avg deal value', fmt: 'money2' },
  ],
  production: [
    { key: 'jobsStarted', label: 'Jobs started', fmt: 'num' },
    { key: 'jobsCompleted', label: 'Jobs completed', fmt: 'num' },
    { key: 'openBlockers', label: 'Open blockers', fmt: 'num' },
  ],
};

/** A 403 means the route is gated for this role — hide, never show an error. */
function is403(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** Null/undefined always renders as an em dash — metrics are never invented. */
function fmtMetric(value: unknown, fmt: Fmt): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (fmt === 'num1') return num(value, 1);
  if (fmt === 'money2') return money2(value);
  if (fmt === 'pct') return pct(value);
  return num(value);
}

function countOrDash(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : num(v);
}

function severityRank(s: Severity | string): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

export default function DashboardPage() {
  const { user, can } = useAuth();
  const [period, setPeriod] = useState<Period>('week');
  const [showAll, setShowAll] = useState(false);

  const canKpi = can('kpi.view');

  const today = useFetch<TodayResponse>('/dashboard/today');
  // Foremen lack kpi.view, so these paths are null and NO request is issued —
  // the routes would answer 403 and there is no reason to ask.
  const funnel = useFetch<{ steps: FunnelStep[] }>(canKpi ? '/dashboard/funnel' : null, [canKpi]);
  const kpis = {
    prospecting: useFetch<Record<string, unknown>>(
      canKpi ? `/dashboard/kpis?${qs({ scope: 'prospecting', period })}` : null,
      [canKpi, period],
    ),
    underwriting: useFetch<Record<string, unknown>>(
      canKpi ? `/dashboard/kpis?${qs({ scope: 'underwriting', period })}` : null,
      [canKpi, period],
    ),
    sales: useFetch<Record<string, unknown>>(
      canKpi ? `/dashboard/kpis?${qs({ scope: 'sales', period })}` : null,
      [canKpi, period],
    ),
    production: useFetch<Record<string, unknown>>(
      canKpi ? `/dashboard/kpis?${qs({ scope: 'production', period })}` : null,
      [canKpi, period],
    ),
  };
  const myTasks = useFetch<{ rows: TaskRow[]; total: number }>(
    !canKpi && user ? `/tasks?${qs({ status: 'open', assignee: user.id, limit: 10 })}` : null,
    [canKpi, user?.id],
  );

  const counts = today.data?.counts;
  const attention = today.data?.needsAttention ?? [];
  const ordered = [...attention].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const visible = showAll ? ordered : ordered.slice(0, 12);
  const groups = SEVERITIES.map((s) => ({
    severity: s,
    items: visible.filter((i) => i.severity === s),
  })).filter((g) => g.items.length > 0);

  const funnelHidden = canKpi && is403(funnel.error) && !funnel.data;
  let funnelContent: ReactNode = null;
  if (canKpi && !funnelHidden) {
    if (funnel.error && !funnel.data) funnelContent = <ErrorState error={funnel.error} onRetry={funnel.reload} />;
    else if (funnel.loading && !funnel.data) funnelContent = <Loading label="Loading funnel…" />;
    else if (funnel.data) funnelContent = <FunnelLadder steps={funnel.data.steps} />;
  }

  const kpiCards = canKpi
    ? SCOPE_ORDER.map((scope) => {
        const res = kpis[scope];
        if (!res.data && is403(res.error)) return null;
        return (
          <Card
            key={scope}
            title={SCOPE_LABELS[scope]}
            actions={
              <LinkButton to="/reports" size="sm" icon={<Icon name="arrowRight" size={14} />}>
                Full breakdown
              </LinkButton>
            }
          >
            {res.error && !res.data ? (
              <ErrorState error={res.error} onRetry={res.reload} />
            ) : res.loading && !res.data ? (
              <Loading label="Loading metrics…" />
            ) : (
              <KeyValue
                items={HEADLINE[scope].map(
                  (m): [ReactNode, ReactNode] => [m.label, fmtMetric(res.data ? res.data[m.key] : null, m.fmt)],
                )}
              />
            )}
          </Card>
        );
      })
    : [];

  let todayContent: ReactNode;
  if (today.error && !today.data) {
    todayContent = <ErrorState error={today.error} onRetry={today.reload} />;
  } else if (today.loading && !today.data) {
    todayContent = <Loading label="Loading today's board…" />;
  } else {
    todayContent = (
      <>
        <Card
          title="Needs attention"
          sub={
            ordered.length
              ? `${ordered.length} open item${ordered.length === 1 ? '' : 's'} across the business`
              : 'Nothing is flagged'
          }
          actions={
            ordered.length > 12 ? (
              <Button size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show less' : `Show all ${ordered.length}`}
              </Button>
            ) : null
          }
        >
          {ordered.length === 0 ? (
            <div className="success-state">Nothing needs attention right now.</div>
          ) : (
            groups.map((g) => (
              <div key={g.severity}>
                <div className="row" style={{ margin: '10px 0 2px' }}>
                  <Badge tone={SEVERITY_TONE[g.severity]}>{titleCase(g.severity)}</Badge>
                  <span className="tiny muted">
                    {g.items.length} of {ordered.filter((i) => i.severity === g.severity).length} shown
                  </span>
                </div>
                <div className="list">
                  {g.items.map((item, idx) => (
                    <div className="list-item" key={`${g.severity}-${idx}-${item.kind}`}>
                      <Badge tone={SEVERITY_TONE[item.severity] ?? 'neutral'}>{titleCase(item.severity)}</Badge>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="strong small truncate">{item.title}</div>
                        <div className="tiny muted">{item.detail}</div>
                      </div>
                      <LinkButton to={item.link || '/'} size="sm">
                        Go
                      </LinkButton>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>

        <div className="grid grid-4" style={{ marginTop: 14 }}>
          <Stat
            label="Running today"
            value={countOrDash(counts?.runningToday)}
            tone="accent"
            detail="jobs in progress or starting today"
          />
          <Stat
            label="Scheduled tomorrow"
            value={countOrDash(counts?.scheduledTomorrow)}
            detail="jobs on tomorrow's schedule"
          />
          <Stat
            label="On hold"
            value={countOrDash(counts?.onHold)}
            tone={counts?.onHold ? 'bad' : undefined}
            detail="blocked by a high-priority task"
          />
          <Stat
            label="Reports outstanding"
            value={countOrDash(counts?.owingDailyReport)}
            tone={counts?.owingDailyReport ? 'info' : undefined}
            detail="in-progress jobs with no report filed today"
          />
        </div>

        {today.error && today.data ? <ErrorState error={today.error} onRetry={today.reload} /> : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Dashboard"
        sub={`${date(Date.now())} · ${user?.roleLabel ?? ''} · ${
          canKpi ? 'Company-wide scope' : 'Field scope — company KPIs restricted for your role'
        }`}
        actions={
          <div className="row wrap">
            <Badge tone={canKpi ? 'blue' : 'amber'}>{canKpi ? 'Company KPIs' : 'Field view'}</Badge>
            {canKpi ? (
              <>
                <span className="tiny muted">KPI period</span>
                <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
              </>
            ) : null}
          </div>
        }
      />

      {todayContent}

      {funnelContent ? (
        <div style={{ marginTop: 14 }}>
          <Card title="Business funnel" sub="Every step is a count or sum over live rows — all time.">
            {funnelContent}
            <div style={{ marginTop: 12 }}>
              <Callout tone="grey">
                Every figure in this ladder is computed from live records in this database, not sample
                data: dials and connects are communication rows, leads are prospects, quotes are bids and
                estimates, won and lost are deals, invoiced and paid are invoices. Nothing is estimated or
                hard-coded.
              </Callout>
            </div>
          </Card>
        </div>
      ) : null}

      {kpiCards.length ? (
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          {kpiCards}
        </div>
      ) : null}

      {!canKpi ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <Card
            title="My open tasks"
            sub="Assigned to you, earliest due first"
            actions={
              <LinkButton to="/tasks" size="sm">
                Open tasks
              </LinkButton>
            }
          >
            {myTasks.error && !myTasks.data ? (
              <ErrorState error={myTasks.error} onRetry={myTasks.reload} />
            ) : myTasks.loading && !myTasks.data ? (
              <Loading label="Loading your tasks…" />
            ) : (myTasks.data?.rows ?? []).length === 0 ? (
              <EmptyState title="No open tasks assigned to you." icon={<Icon name="check" size={22} />}>
                Everything on your list is complete.
              </EmptyState>
            ) : (
              <div className="list">
                {(myTasks.data?.rows ?? []).map((t) => (
                  <div className="list-item" key={t.id}>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="strong small truncate">{t.title || 'Untitled task'}</div>
                      <div className="tiny muted">
                        {t.type ? `${titleCase(t.type)} · ` : ''}due {rel(t.due_at)}
                      </div>
                    </div>
                    {t.priority === 1 ? <Badge tone="red">Blocker</Badge> : null}
                    <LinkButton to="/tasks" size="sm">
                      Open
                    </LinkButton>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Callout tone="grey">
            Company-wide KPIs — the conversion funnel and the reporting dashboards — require the{' '}
            <b>kpi.view</b> permission, which the {user?.roleLabel ?? 'current'} role does not have, so no
            KPI request is even made from this page. Everything above covers only your own assignments and
            today's operational records; nothing shown here is estimated.
          </Callout>
        </div>
      ) : null}
    </>
  );
}

/** Horizontal conversion ladder — bars scale to the largest count we actually have. */
function FunnelLadder({ steps }: { steps: FunnelStep[] }) {
  const max = steps.reduce((m, s) => Math.max(m, Number(s.count) || 0), 0);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row tiny muted" style={{ gap: 10 }}>
        <span style={{ width: 140 }}>Step</span>
        <span className="grow" />
        <span style={{ width: 64, textAlign: 'right' }}>Count</span>
        <span style={{ width: 96, textAlign: 'right' }}>Value</span>
        <span style={{ width: 78, textAlign: 'right' }}>From prev</span>
      </div>
      {steps.map((s) => (
        <div className="row" style={{ gap: 10 }} key={s.key}>
          <span className="small strong truncate" style={{ width: 140 }}>
            {s.label}
          </span>
          <span className="grow">
            <Meter value={max > 0 ? (Number(s.count) / max) * 100 : 0} />
          </span>
          <span className="num right" style={{ width: 64 }}>
            {num(s.count)}
          </span>
          <span className="num right" style={{ width: 96 }}>
            {s.value === null || s.value === undefined ? '—' : money(s.value)}
          </span>
          {/* conversionPct is already ×100 server-side; pctRaw shows it without re-scaling. */}
          <span className="num right muted" style={{ width: 78 }}>
            {s.conversionPct === null || s.conversionPct === undefined ? '—' : pctRaw(s.conversionPct)}
          </span>
        </div>
      ))}
    </div>
  );
}
