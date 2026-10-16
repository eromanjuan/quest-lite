import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { qs } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  Input,
  LinkButton,
  Loading,
  PageHead,
  Select,
  Stat,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateShort, money, num, titleCase } from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Types and constants                                                 */
/* ------------------------------------------------------------------ */

type ProjectRow = Record<string, any>;

interface ProjectList {
  rows: ProjectRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const PAGE_SIZE = 25;

/**
 * Seed list for the status filter. The server filters on the exact value, so
 * anything it actually returns is merged in — rows always win over this list.
 */
const STATUS_SEED = ['active', 'complete', 'invoiced', 'closed'];

const STATUS_TONE: Record<string, Tone> = {
  active: 'green',
  complete: 'blue',
  invoiced: 'violet',
  closed: 'neutral',
  cancelled: 'red',
};

/**
 * The list endpoint names its counts differently from the brief
 * (job_count / open_task_count / last_report_at), so every accessor takes a
 * defensive list and reports "absent" rather than guessing a zero.
 */
function sumField(rows: ProjectRow[], keys: string[]): number | null {
  let seen = false;
  let sum = 0;
  for (const r of rows) {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        seen = true;
        sum += v;
        break;
      }
    }
  }
  return seen ? sum : null;
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();

  // Contract value and change-order totals are pricing: foremen never see them.
  const moneyVisible = can('production.financials');

  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  // Any filter change starts the result set over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [dq, status]);

  const path = `/projects${qs({ q: dq, status, limit: PAGE_SIZE, offset })}`;
  const list = useFetch<ProjectList>(path, [path]);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const limit = list.data?.limit ?? PAGE_SIZE;
  const hasMore = list.data?.hasMore ?? offset + rows.length < total;

  const statusOptions = useMemo(() => {
    const seen = new Set(STATUS_SEED);
    for (const r of rows) {
      const s = String(r.status ?? '');
      if (s) seen.add(s);
    }
    return [...seen];
  }, [rows]);

  const jobsSum = sumField(rows, ['job_count', 'jobs', 'jobs_count']);
  const blockerSum = sumField(rows, ['open_blockers', 'open_task_count', 'open_tasks', 'blockers']);
  const activeCount = rows.filter((r) => String(r.status ?? '') === 'active').length;

  const filtersActive = !!(dq || status);

  let body;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading projects…" />;
  } else if (rows.length === 0) {
    body = filtersActive ? (
      <EmptyState title="No projects match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the search and status filter to see the full list.
      </EmptyState>
    ) : (
      <EmptyState title="No projects yet" icon={<Icon name="production" size={22} />}>
        Marking a deal <b>Won</b> in Sales hands the contract over to Production and creates its
        project here — nothing is created from this screen.
        <br />
        Open the sales pipeline to win your first deal.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {!moneyVisible ? (
          <Callout tone="grey">Cost and pricing detail is restricted for your role.</Callout>
        ) : null}

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Project</th>
                <th>Status</th>
                <th>Type</th>
                <th>Address</th>
                <th>Contact</th>
                <th className="num">Contract value</th>
                <th className="num">Change orders</th>
                <th className="num">Jobs</th>
                <th>Started</th>
                <th>Last report</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={String(r.id ?? r.project_no)}
                  className="clickable"
                  onClick={() => navigate(`/projects/${r.id}`)}
                >
                  <td>
                    <div className="mono small muted">{r.project_no ?? '—'}</div>
                    <div className="strong truncate" style={{ maxWidth: 220 }} title={r.name ?? ''}>
                      {r.name || '—'}
                    </div>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[String(r.status ?? '')] ?? 'neutral'}>
                      {r.status ? titleCase(String(r.status)) : '—'}
                    </Badge>
                  </td>
                  <td className="nowrap">
                    <Badge tone="outline">{r.project_type ? titleCase(String(r.project_type)) : '—'}</Badge>
                  </td>
                  <td className="truncate" style={{ maxWidth: 200 }} title={r.address ?? ''}>
                    {r.address || '—'}
                  </td>
                  <td className="truncate" style={{ maxWidth: 160 }} title={r.contact_name ?? ''}>
                    {r.contact_name ?? r.company_name ?? '—'}
                  </td>
                  <td className="num nowrap">{moneyVisible ? money(r.contract_value ?? r.original_contract) : '—'}</td>
                  <td className="num nowrap">
                    {moneyVisible ? money(r.change_order_total ?? r.change_orders_total) : '—'}
                  </td>
                  <td className="num">{r.job_count ?? r.jobs ?? r.jobs_count ?? '—'}</td>
                  <td className="nowrap">{dateShort(r.started_at)}</td>
                  <td className="nowrap">{dateShort(r.last_report_at ?? r.last_report ?? null)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <LinkButton to={`/projects/${r.id}`} size="sm">
                      Open
                    </LinkButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">
            {total === 0 ? 'No rows' : `Showing ${offset + 1}–${offset + rows.length} of ${total}`}
          </span>
          <span className="spacer" />
          <Button
            size="sm"
            disabled={offset === 0 || list.loading}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            disabled={!hasMore || list.loading}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Production"
        sub="Projects handed over when a deal is marked Won — each one carries its jobs, draws, change orders and daily reports."
        actions={
          <LinkButton to="/sales" size="sm" icon={<Icon name="sales" size={14} />}>
            Sales pipeline
          </LinkButton>
        }
      />

      <div className="grid grid-4">
        <Stat label="Projects" value={list.data ? num(total) : '—'} detail={`${rows.length} on this page`} />
        <Stat label="Active" value={num(activeCount)} detail="on this page" tone="good" />
        <Stat
          label="Open blockers"
          value={blockerSum === null ? '—' : num(blockerSum)}
          detail="on this page"
          tone={blockerSum !== null && blockerSum > 0 ? 'bad' : undefined}
        />
        <Stat label="Jobs" value={jobsSum === null ? '—' : num(jobsSum)} detail="on this page" />
      </div>

      <div className="filters">
        <Input
          type="search"
          aria-label="Search projects"
          placeholder="Search project no, name or address…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 230 }}
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: '', label: 'Any status' },
            ...statusOptions.map((s) => ({ value: s, label: titleCase(s) })),
          ]}
        />
        <span className="spacer" />
        {filtersActive ? (
          <Button
            size="sm"
            onClick={() => {
              setQ('');
              setStatus('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}
    </>
  );
}
