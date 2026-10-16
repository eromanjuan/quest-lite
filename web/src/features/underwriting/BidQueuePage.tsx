import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { patch, post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch, useQueryState } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  FormActions,
  Input,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Select,
  Stat,
  TextArea,
  TemperatureDot,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  dateShort,
  fromLocalInputValue,
  num,
  stageLabel,
  titleCase,
  TRADE_LABELS,
} from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Constants — mirrored from server/routes/bids.ts                    */
/* ------------------------------------------------------------------ */

const STAGES = ['scope', 'takeoff', 'uw_sheet', 'quote_built'];

const STAGE_TONE: Record<string, Tone> = {
  scope: 'neutral',
  takeoff: 'blue',
  uw_sheet: 'violet',
  quote_built: 'green',
};

const TEMPERATURES = ['hot', 'warm', 'cold'];

const PAGE_SIZE = 25;

/**
 * The server's "waiting" filter keys are waiting_info / waiting_sub_quote /
 * site_visit_needed. Rows only carry the display name, so the stat card
 * matches on that wording rather than pretending to know the keys.
 */
const WAITING_RE = /waiting|site visit/i;

function stageTone(stage: unknown): Tone {
  return STAGE_TONE[String(stage)] ?? 'neutral';
}

function temperatureTone(temp: unknown): Tone {
  const t = String(temp);
  return t === 'hot' ? 'red' : t === 'cold' ? 'blue' : 'amber';
}

/** `type="date"` gives YYYY-MM-DD, which Date() would read as UTC midnight — pin it local. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

/** `missing_info` is a JSON string[] — count it only when it parses as one. */
function missingCount(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

interface BidPage {
  rows: any[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function BidQueuePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const { state: f, set, reset } = useQueryState({
    q: '',
    stage: '',
    trade: '',
    estimatorId: '',
    dispositionId: '',
    temperature: '',
    overdue: '',
    waiting: '',
  });
  const [offset, setOffset] = useState(0);
  const [newOpen, setNewOpen] = useState(false);

  const q = useDebounced(f.q, 300);
  const path = `/bids${qs({
    q,
    stage: f.stage,
    trade: f.trade,
    estimatorId: f.estimatorId,
    dispositionId: f.dispositionId,
    temperature: f.temperature,
    overdue: f.overdue,
    waiting: f.waiting,
    limit: PAGE_SIZE,
    offset,
  })}`;

  const queue = useFetch<BidPage>(path, [path]);
  const config = useFetch<any>('/config', []);
  const roster = useFetch<{ rows: any[] }>('/auth/roster', []);

  const rows = queue.data?.rows ?? [];

  /** Changing any filter sends the reader back to the first page. */
  const setFilter = <K extends keyof typeof f>(key: K, value: string) => {
    set(key, value);
    setOffset(0);
  };

  const clearFilters = () => {
    reset();
    setOffset(0);
  };

  const overdueCount = useMemo(
    () => rows.filter((r) => r.quote_due_at && Number(r.quote_due_at) < Date.now()).length,
    [rows],
  );
  const waitingCount = useMemo(
    () => rows.filter((r) => WAITING_RE.test(String(r.disposition_name ?? ''))).length,
    [rows],
  );
  const avgAgeDays = useMemo(() => {
    const ages = rows.map((r) => Number(r.bid_age_days)).filter((n) => Number.isFinite(n));
    if (!ages.length) return null;
    return Math.round((ages.reduce((s, n) => s + n, 0) / ages.length) * 10) / 10;
  }, [rows]);

  const trades: string[] = (config.data?.trades ?? []).slice().sort();
  const estimators = roster.data?.rows ?? [];
  const bidDispositions = (config.data?.dispositions ?? []).filter((d: any) => d.workspace === 'bid');

  const total = queue.data ? num(queue.data.total) : '—';
  const first = queue.data && rows.length ? queue.data.offset + 1 : null;
  const last = queue.data && rows.length ? queue.data.offset + rows.length : null;

  return (
    <div className="stack">
      <PageHead
        title="Underwriting / Bid Queue"
        sub={
          queue.data
            ? `${num(queue.data.total)} bid${queue.data.total === 1 ? '' : 's'} match the current filters · ${overdueCount} overdue on this page · ${waitingCount} waiting on this page`
            : queue.error
              ? 'Bid queue could not be loaded.'
              : 'Loading bid queue…'
        }
      />

      {/* ------------------------------ filters ------------------------------ */}
      <div className="filters">
        <Input
          aria-label="Search bids"
          placeholder="Search bid no, address, contact…"
          value={f.q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <Select
          aria-label="Stage"
          value={f.stage}
          onChange={(e) => setFilter('stage', e.target.value)}
          options={[
            { value: '', label: 'All stages' },
            ...STAGES.map((s) => ({ value: s, label: stageLabel(s) })),
          ]}
        />
        <Select
          aria-label="Trade"
          value={f.trade}
          onChange={(e) => setFilter('trade', e.target.value)}
          options={[
            { value: '', label: 'All trades' },
            ...trades.map((t) => ({ value: t, label: TRADE_LABELS[t] ?? titleCase(t) })),
          ]}
        />
        <Select
          aria-label="Estimator"
          value={f.estimatorId}
          onChange={(e) => setFilter('estimatorId', e.target.value)}
          options={[
            { value: '', label: 'All estimators' },
            ...estimators.map((u: any) => ({ value: u.id, label: u.name })),
          ]}
        />
        <Select
          aria-label="Disposition"
          value={f.dispositionId}
          onChange={(e) => setFilter('dispositionId', e.target.value)}
          options={[
            { value: '', label: 'All dispositions' },
            ...bidDispositions.map((d: any) => ({ value: d.id, label: d.name })),
          ]}
        />
        <Select
          aria-label="Temperature"
          value={f.temperature}
          onChange={(e) => setFilter('temperature', e.target.value)}
          options={[
            { value: '', label: 'Any temperature' },
            ...TEMPERATURES.map((t) => ({ value: t, label: titleCase(t) })),
          ]}
        />
        <Checkbox
          label="Overdue only"
          checked={f.overdue === '1'}
          onChange={(e) => setFilter('overdue', e.target.checked ? '1' : '')}
        />
        <Checkbox
          label="Waiting only"
          checked={f.waiting === '1'}
          onChange={(e) => setFilter('waiting', e.target.checked ? '1' : '')}
        />
        <span className="spacer" />
        {can('bid.write') ? (
          <Button variant="primary" onClick={() => setNewOpen(true)} icon={<Icon name="plus" size={14} />}>
            New bid
          </Button>
        ) : null}
      </div>

      {/* -------------------------------- stats ------------------------------- */}
      <div className="grid grid-4">
        <Stat label="Total bids" value={total} tone="info" detail={queue.loading ? 'Updating…' : undefined} />
        <Stat label="Overdue" value={queue.data ? overdueCount : '—'} tone={overdueCount > 0 ? 'bad' : undefined} detail="Past the quote due date" />
        <Stat label="Waiting on info" value={queue.data ? waitingCount : '—'} tone={waitingCount > 0 ? undefined : 'good'} detail="Waiting / site visit dispositions" />
        <Stat label="Avg bid age" value={avgAgeDays === null ? '—' : `${avgAgeDays}d`} detail="Mean age of the rows shown" />
      </div>

      {/* -------------------------------- table ------------------------------- */}
      {queue.error && !queue.data ? (
        <ErrorState error={queue.error} onRetry={queue.reload} />
      ) : queue.loading && !queue.data ? (
        <Loading label="Loading bids…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bids match these filters"
          icon={<span>🔎</span>}
          action={
            <Button onClick={clearFilters} size="sm">
              Clear filters
            </Button>
          }
        >
          Open a new bid, or widen the search to see the rest of the queue.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Bid</th>
                <th>Project</th>
                <th>Contact</th>
                <th>Estimator</th>
                <th>Stage</th>
                <th>Disposition</th>
                <th>Temp</th>
                <th>Due</th>
                <th className="num">Age</th>
                <th>Missing</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const overdue = !!r.quote_due_at && Number(r.quote_due_at) < Date.now();
                const missing = missingCount(r.missing_info);
                return (
                  <tr
                    key={r.id}
                    className="clickable"
                    onClick={() => navigate(`/bids/${r.id}`)}
                  >
                    <td className="nowrap">
                      <span className="mono strong">{r.bid_no ?? '—'}</span>{' '}
                      <Badge tone="blue">{TRADE_LABELS[r.trade] ?? titleCase(r.trade)}</Badge>
                    </td>
                    <td className="truncate" style={{ maxWidth: 260 }} title={r.project_address || r.scope_summary || ''}>
                      {r.project_address || r.scope_summary || <span className="muted">—</span>}
                    </td>
                    <td className="nowrap">{r.contact_name || <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {r.estimator_name || <span className="muted">Unassigned</span>}
                    </td>
                    <td className="nowrap">
                      <Badge tone={stageTone(r.stage)}>{stageLabel(r.stage)}</Badge>
                    </td>
                    <td className="nowrap">
                      {r.disposition_name ? (
                        <Badge tone="outline">{r.disposition_name}</Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <TemperatureDot value={String(r.temperature ?? '')} />
                    </td>
                    <td className="nowrap">
                      {r.quote_due_at ? (
                        <>
                          <span>{dateShort(r.quote_due_at)}</span>
                          {overdue ? (
                            <div className="tiny" style={{ color: 'var(--red)' }}>
                              overdue
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num nowrap">
                      {typeof r.bid_age_days === 'number' ? `${r.bid_age_days}d` : '—'}
                    </td>
                    <td>
                      {missing === null || missing === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <Badge tone="amber">{missing}</Badge>
                      )}
                    </td>
                    <td className="nowrap">
                      <LinkButton to={`/bids/${r.id}`} size="sm">
                        Open
                      </LinkButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ----------------------------- pagination ----------------------------- */}
      <div className="row wrap">
        <span className="grow small muted">
          {queue.data && rows.length ? `Showing ${first}–${last} of ${num(queue.data.total)}` : '—'}
        </span>
        <Button
          size="sm"
          disabled={offset === 0 || queue.loading}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          disabled={!queue.data?.hasMore || queue.loading}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next
        </Button>
      </div>

      {newOpen ? (
        <NewBidModal
          trades={trades}
          roster={estimators}
          onClose={() => setNewOpen(false)}
          onCreated={(row, warning) => {
            setNewOpen(false);
            toast.success('Bid created', `${row?.bid_no ?? 'The new bid'} is open in Underwriting.`);
            if (warning) toast.error('Delivery mode not saved', warning);
            if (row?.id) navigate(`/bids/${row.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New bid                                                             */
/* ------------------------------------------------------------------ */

function NewBidModal({
  trades,
  roster,
  onClose,
  onCreated,
}: {
  trades: string[];
  roster: any[];
  onClose: () => void;
  onCreated: (row: any, warning?: string) => void;
}) {
  const [trade, setTrade] = useState('');
  const [contactId, setContactId] = useState('');
  const [projectAddress, setProjectAddress] = useState('');
  const [scopeSummary, setScopeSummary] = useState('');
  const [estimatorId, setEstimatorId] = useState('');
  const [quoteDueAt, setQuoteDueAt] = useState('');
  const [takeoffRequired, setTakeoffRequired] = useState(false);
  const [performMode, setPerformMode] = useState('self');
  const [contactQ, setContactQ] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const dq = useDebounced(contactQ, 300);
  const contacts = useFetch<{ rows: any[] }>(`/contacts${qs({ limit: 50, q: dq })}`, [dq]);

  const fieldError = (name: string) => err?.fieldErrors?.[name];
  const valid = !!trade && !!contactId && scopeSummary.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setPending(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        contactId,
        trade,
        projectAddress,
        scopeSummary,
        quoteDueAt: dateToMs(quoteDueAt),
        takeoffRequired,
        // The create schema has no delivery-mode field yet, so this key is
        // ignored on POST and applied with the patch below.
        perform_mode: performMode,
      };
      if (estimatorId) body.estimatorId = estimatorId;
      const res = await post<{ row: any }>('/bids', body);

      let warning: string | undefined;
      if (performMode !== 'self') {
        try {
          await patch(`/bids/${res.row.id}`, { perform_mode: performMode });
        } catch (e) {
          warning = e instanceof Error ? e.message : 'The delivery mode could not be saved.';
        }
      }
      onCreated(res.row, warning);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="New bid"
      sub="Opens a bid in the underwriting workspace at the scope stage."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!valid}>
            Create bid
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? <ErrorState error={err} /> : null}

        <div className="form-grid">
          <Select
            label="Trade"
            required
            placeholder="Select a trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            error={fieldError('trade')}
            options={trades.map((t) => ({ value: t, label: TRADE_LABELS[t] ?? titleCase(t) }))}
          />

          <div className="field span-2">
            <label htmlFor="new-bid-contact">
              Contact<span className="req">*</span>
            </label>
            <Input
              id="new-bid-contact"
              placeholder="Search contacts by name, email or phone"
              value={contactQ}
              onChange={(e) => setContactQ(e.target.value)}
            />
            {contacts.loading && !contacts.data ? (
              <div className="hint">Loading contacts…</div>
            ) : contacts.error ? (
              <ErrorState error={contacts.error} onRetry={contacts.reload} />
            ) : (
              <Select
                aria-label="Contact"
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                placeholder="Select a contact"
                error={fieldError('contactId')}
                options={(contacts.data?.rows ?? []).map((c: any) => ({
                  value: c.id,
                  label: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() + (c.company_name ? ` · ${c.company_name}` : ''),
                }))}
              />
            )}
          </div>

          <Input
            label="Project address"
            value={projectAddress}
            onChange={(e) => setProjectAddress(e.target.value)}
            error={fieldError('projectAddress')}
            placeholder="Street, city"
          />

          <div className="field span-2">
            <label htmlFor="new-bid-scope">
              Scope summary<span className="req">*</span>
            </label>
            <TextArea
              id="new-bid-scope"
              rows={3}
              required
              value={scopeSummary}
              onChange={(e) => setScopeSummary(e.target.value)}
              placeholder="What work is being priced?"
              error={fieldError('scopeSummary')}
            />
          </div>

          <Select
            label="Estimator"
            value={estimatorId}
            onChange={(e) => setEstimatorId(e.target.value)}
            placeholder="Unassigned"
            error={fieldError('estimatorId')}
            options={roster.map((u: any) => ({ value: u.id, label: u.name }))}
          />

          <Input
            label="Quote due"
            type="date"
            value={quoteDueAt}
            onChange={(e) => setQuoteDueAt(e.target.value)}
            error={fieldError('quoteDueAt')}
          />

          <Select
            label="Delivery mode"
            value={performMode}
            onChange={(e) => setPerformMode(e.target.value)}
            options={[
              { value: 'self', label: 'Self perform' },
              { value: 'sub', label: 'Subcontracted' },
              { value: 'mixed', label: 'Mixed' },
            ]}
          />

          <div className="field">
            <label>Takeoff</label>
            <Checkbox
              label="Takeoff required"
              hint="Quantities must be measured before a quote can be released."
              checked={takeoffRequired}
              onChange={(e) => setTakeoffRequired(e.target.checked)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
