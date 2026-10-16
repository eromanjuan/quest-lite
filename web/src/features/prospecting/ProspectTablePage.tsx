import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  BlockerList,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Select,
  TemperatureDot,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  TEMPERATURE_LABELS,
  TRADE_LABELS,
  dateShort,
  fromLocalInputValue,
  rel,
  stageLabel,
  titleCase,
} from '../../lib/format';

interface PRow {
  id: string;
  handoff_at?: number | null;
  [key: string]: any;
}

interface ConfigData {
  leadSources?: any[];
  territories?: any[];
  timingBuckets?: any[];
  dispositions?: any[];
  trades?: string[];
  [key: string]: any;
}

interface RosterRow {
  id: string;
  name: string;
  [key: string]: any;
}

const TEMPS = ['hot', 'warm', 'cold'] as const;

const STAGE_TONES: Record<string, 'blue' | 'accent' | 'neutral'> = {
  prospect: 'blue',
  lead: 'accent',
  nurturing: 'neutral',
};

/** Date inputs hand back "YYYY-MM-DD"; pin it to local midnight so the day survives formatting. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/* ------------------------------------------------------------------ */
/* Filter state + bar (duplicated from the board: only four files may  */
/* exist in this folder, so there is no shared prospect module).       */
/* ------------------------------------------------------------------ */

function useProspectFilters() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [temperature, setTemperature] = useState('');
  const [timing, setTiming] = useState('');
  const [dispositionId, setDispositionId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [sort, setSort] = useState('next_followup');

  return {
    q,
    setQ,
    dq,
    temperature,
    setTemperature,
    timing,
    setTiming,
    dispositionId,
    setDispositionId,
    ownerId,
    setOwnerId,
    overdue,
    setOverdue,
    sort,
    setSort,
    query: {
      q: dq,
      temperature,
      timing,
      dispositionId,
      ownerId,
      overdue: overdue ? 1 : undefined,
      sort,
    },
    active: !!(dq || temperature || timing || dispositionId || ownerId || overdue),
    reset: () => {
      setQ('');
      setTemperature('');
      setTiming('');
      setDispositionId('');
      setOwnerId('');
      setOverdue(false);
      setSort('next_followup');
    },
  };
}

type FilterState = ReturnType<typeof useProspectFilters>;

function ProspectFilters({
  f,
  config,
  roster,
}: {
  f: FilterState;
  config: ConfigData | null;
  roster: RosterRow[];
}) {
  const dispositions = (config?.dispositions ?? []).filter(
    (d: any) => d.workspace === 'prospect' && d.active === 1,
  );
  const pending = !config;

  return (
    <div className="filters">
      <Input
        type="search"
        aria-label="Search prospects"
        placeholder="Search name, address, scope…"
        value={f.q}
        onChange={(e) => f.setQ(e.target.value)}
        style={{ minWidth: 210 }}
      />
      <Select
        aria-label="Temperature"
        disabled={pending}
        value={f.temperature}
        onChange={(e) => f.setTemperature(e.target.value)}
        options={[
          { value: '', label: 'Any temperature' },
          ...TEMPS.map((t) => ({ value: t, label: TEMPERATURE_LABELS[t] ?? titleCase(t) })),
        ]}
      />
      <Select
        aria-label="Timing"
        disabled={pending}
        value={f.timing}
        onChange={(e) => f.setTiming(e.target.value)}
        options={[
          { value: '', label: 'Any timing' },
          ...(config?.timingBuckets ?? []).map((b: any) => ({ value: b.key, label: b.name })),
        ]}
      />
      <Select
        aria-label="Disposition"
        disabled={pending}
        value={f.dispositionId}
        onChange={(e) => f.setDispositionId(e.target.value)}
        options={[
          { value: '', label: 'Any disposition' },
          ...dispositions.map((d: any) => ({ value: d.id, label: d.name })),
        ]}
      />
      <Select
        aria-label="Owner"
        disabled={pending}
        value={f.ownerId}
        onChange={(e) => f.setOwnerId(e.target.value)}
        options={[
          { value: '', label: 'Any owner' },
          ...roster.map((r) => ({ value: r.id, label: r.name })),
        ]}
      />
      <Checkbox
        label="Overdue follow-ups only"
        checked={f.overdue}
        onChange={(e) => f.setOverdue(e.target.checked)}
      />
      <span className="spacer" />
      <Select
        aria-label="Sort"
        value={f.sort}
        onChange={(e) => f.setSort(e.target.value)}
        options={[
          { value: 'next_followup', label: 'Sort: next follow-up' },
          { value: 'created', label: 'Sort: newest' },
          { value: 'temperature', label: 'Sort: temperature' },
          { value: 'last_contact', label: 'Sort: last contact' },
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 25;

export default function ProspectTablePage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const f = useProspectFilters();
  const [offset, setOffset] = useState(0);
  const [handoffTarget, setHandoffTarget] = useState<PRow | null>(null);

  const canWrite = can('prospect.write');
  const canHandoff = can('prospect.write') && can('prospect.handoff');

  const config = useFetch<ConfigData>('/config');
  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');

  // Any filter change starts the result set over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [f.dq, f.temperature, f.timing, f.dispositionId, f.ownerId, f.overdue, f.sort]);

  const path = `/prospects${qs({ ...f.query, limit: PAGE_SIZE, offset })}`;
  const list = useFetch<{
    rows: PRow[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }>(path, [path]);

  const rows = list.data?.rows ?? [];
  const limit = list.data?.limit ?? PAGE_SIZE;
  const total = list.data?.total ?? 0;
  const hasMore = list.data?.hasMore ?? offset + rows.length < total;

  const timingName = (key?: string | null): string => {
    if (!key) return '—';
    return (config.data?.timingBuckets ?? []).find((b: any) => b.key === key)?.name ?? titleCase(key);
  };

  let body: ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading prospects…" />;
  } else if (rows.length === 0) {
    body = f.active ? (
      <EmptyState title="No prospects match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the filters to see the full list.
      </EmptyState>
    ) : (
      <EmptyState title="No prospects yet" icon={<Icon name="prospects" size={22} />}>
        Create your first prospect from the board view.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Prospect</th>
                <th>Temperature</th>
                <th>Stage</th>
                <th>Disposition</th>
                <th>Scope</th>
                <th>Next follow-up</th>
                <th>Last contact</th>
                <th>Owner</th>
                <th className="num">Open tasks</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const name = `${r.contact_first ?? ''} ${r.contact_last ?? ''}`.trim() || '—';
                const scope = r.scope_summary || r.project_address || '—';
                const overdue =
                  r.next_followup_at != null && Number(r.next_followup_at) < Date.now();
                const tempLabel = r.temperature
                  ? TEMPERATURE_LABELS[r.temperature] ?? titleCase(r.temperature)
                  : '—';
                return (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/prospects/${r.id}`)}>
                    <td>
                      <div className="strong truncate" style={{ maxWidth: 220 }} title={name}>
                        {name}
                      </div>
                      <div className="small muted truncate" style={{ maxWidth: 220 }} title={r.company_name ?? ''}>
                        {r.company_name ?? '—'}
                      </div>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 5 }}>
                        <TemperatureDot value={r.temperature ?? ''} />
                        <span className="small">{tempLabel}</span>
                      </span>
                    </td>
                    <td>
                      <Badge tone={STAGE_TONES[r.stage ?? ''] ?? 'neutral'}>
                        {r.stage ? stageLabel(r.stage) : '—'}
                      </Badge>
                    </td>
                    <td className="nowrap">{r.disposition_name ?? '—'}</td>
                    <td>
                      <span className="truncate" style={{ display: 'inline-block', maxWidth: 230 }} title={scope}>
                        {scope}
                      </span>
                    </td>
                    <td className="nowrap">
                      {r.next_followup_at != null ? (
                        <>
                          <div>{dateShort(r.next_followup_at)}</div>
                          <div
                            className="tiny"
                            style={
                              overdue
                                ? { color: 'var(--red)', fontWeight: 600 }
                                : { color: 'var(--muted)' }
                            }
                          >
                            {overdue
                              ? `overdue · ${rel(r.next_followup_at)}`
                              : rel(r.next_followup_at)}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="nowrap small muted">{rel(r.last_contact_at)}</td>
                    <td className="nowrap">{r.owner_name ?? '—'}</td>
                    <td className="num">{r.open_tasks ?? '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row">
                        <Button size="sm" onClick={() => navigate(`/prospects/${r.id}`)}>
                          Open
                        </Button>
                        {r.handoff_at == null ? (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!canHandoff}
                            title={canHandoff ? undefined : 'You do not have permission to hand off prospects.'}
                            onClick={() => setHandoffTarget(r)}
                          >
                            Hand off
                          </Button>
                        ) : r.bid_no ? (
                          <Badge tone="violet">{r.bid_no}</Badge>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">
            {total === 0
              ? 'No rows'
              : `Showing ${offset + 1}–${offset + rows.length} of ${total}`}
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
        title="Prospect table"
        sub={`Every prospect as a row · ${total} matching`}
        actions={
          <>
            <LinkButton to="/prospecting" size="sm" icon={<Icon name="dashboard" size={14} />}>
              Board view
            </LinkButton>
            <LinkButton to="/call-queue" size="sm" icon={<Icon name="phone" size={14} />}>
              Call queue
            </LinkButton>
          </>
        }
      />

      {config.error || roster.error ? (
        <ErrorState
          error={config.error ?? roster.error}
          onRetry={() => {
            if (config.error) config.reload();
            if (roster.error) roster.reload();
          }}
        />
      ) : null}

      <ProspectFilters f={f} config={config.data} roster={roster.data?.rows ?? []} />

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}

      {handoffTarget ? (
        <HandoffModal
          prospect={handoffTarget}
          config={config.data}
          roster={roster.data?.rows ?? []}
          onClose={() => setHandoffTarget(null)}
          onDone={() => {
            setHandoffTarget(null);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Hand-off to Underwriting                                           */
/* ------------------------------------------------------------------ */

function HandoffModal({
  prospect,
  config,
  roster,
  onClose,
  onDone,
}: {
  prospect: PRow;
  config: ConfigData | null;
  roster: RosterRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [trade, setTrade] = useState('');
  const [estimatorId, setEstimatorId] = useState('');
  const [quoteDue, setQuoteDue] = useState('');
  const [takeoffRequired, setTakeoffRequired] = useState(false);
  const [performMode, setPerformMode] = useState('self');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // A 422 carries the blocker list; it stays in this dialog until the gaps are closed.
  const blockers =
    error && error.status === 422
      ? (error.blockers ?? []).map((b: any) =>
          typeof b === 'string'
            ? { label: b }
            : { label: b?.label ?? 'Blocked', detail: b?.detail },
        )
      : [];

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await post<any>(`/prospects/${prospect.id}/handoff`, {
        trade,
        estimatorId: estimatorId || null,
        quoteDueAt: dateToMs(quoteDue),
        takeoffRequired,
        performMode,
      });
      const bidNo = res?.bid?.bid_no;
      toast.success(bidNo ? `Handed off as ${bidNo}` : 'Handed off to Underwriting');
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err);
        if (err.status === 409) toast.error('Handoff rejected', err.message);
      } else {
        toast.error('Handoff failed', errText(err));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Hand off to Underwriting"
      sub={`${prospect.contact_first ?? ''} ${prospect.contact_last ?? ''}`.trim() || prospect.id}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={pending} onClick={submit}>
            Create bid
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className={error.status === 422 ? 'warn-state' : 'error-state'} role="alert">
            {error.message}
          </div>
        ) : null}
        {blockers.length ? (
          <BlockerList items={blockers} />
        ) : null}

        <Select
          label="Trade"
          required
          value={trade}
          onChange={(e) => setTrade(e.target.value)}
          placeholder="Select a trade"
          options={(config?.trades ?? []).map((t: string) => ({
            value: t,
            label: TRADE_LABELS[t] ?? titleCase(t),
          }))}
        />
        <Select
          label="Estimator"
          value={estimatorId}
          onChange={(e) => setEstimatorId(e.target.value)}
          hint="Optional — unassigned bids land in the estimator queue."
          placeholder="Anyone"
          options={roster.map((r) => ({ value: r.id, label: r.name }))}
        />
        <Input
          label="Quote due"
          type="date"
          value={quoteDue}
          onChange={(e) => setQuoteDue(e.target.value)}
        />
        <Select
          label="Perform mode"
          value={performMode}
          onChange={(e) => setPerformMode(e.target.value)}
          options={[
            { value: 'self', label: 'Self perform' },
            { value: 'sub', label: 'Subcontract' },
            { value: 'mixed', label: 'Mixed' },
          ]}
        />
        <Checkbox
          label="Takeoff required"
          checked={takeoffRequired}
          onChange={(e) => setTakeoffRequired(e.target.checked)}
        />
      </div>
    </Modal>
  );
}
