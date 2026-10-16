import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  BlockerList,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Kanban,
  Loading,
  Modal,
  PageHead,
  Select,
  Stat,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateShort, fromLocalInputValue, money, num, pct, rel, titleCase, TRADE_LABELS } from '../../lib/format';

/** Mirrors STAGES in server/routes/deals.ts, in board order. */
const STAGES = [
  'review',
  'estimate_sent',
  'negotiating',
  'contract_sent',
  'waiting_to_sign',
  'won',
  'lost',
] as const;

/** The stages closers actively work — won/lost are outcomes, not pipeline. */
const OPEN_STAGES = ['estimate_sent', 'negotiating', 'contract_sent', 'waiting_to_sign'];

interface DealRow {
  id: string;
  deal_no: string;
  project_name: string | null;
  company_name: string | null;
  contact_first: string | null;
  contact_last: string | null;
  value: number | null;
  stage: string;
  closer_id: string | null;
  expected_close_at: number | null;
  open_tasks: number | null;
  last_comm_at: number | null;
  signature_status: string | null;
  [key: string]: any;
}

interface StageTotal {
  count: number;
  value: number;
}

interface ConfigData {
  wonGates?: Array<{ project_type: string; [key: string]: any }>;
  [key: string]: any;
}

interface RosterRow {
  id: string;
  name: string;
  [key: string]: any;
}

/** Date inputs hand back "YYYY-MM-DD"; pin it to local midnight so the day survives formatting. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

export default function SalesBoardPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canWrite = can('deal.write');

  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [closerId, setCloserId] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [gateBlockers, setGateBlockers] = useState<Array<{ label: string; detail?: string }> | null>(null);

  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');
  const config = useFetch<ConfigData>('/config');

  const path = `/deals${qs({ q: dq, closerId, limit: 500 })}`;
  const list = useFetch<{ rows: DealRow[]; total: number; totals: Record<string, StageTotal> }>(path, [path]);

  const rows = list.data?.rows ?? [];
  const totals = list.data?.totals ?? {};
  const sumStage = (stages: string[], key: 'count' | 'value') =>
    stages.reduce((a, s) => a + (totals[s]?.[key] ?? 0), 0);
  const filtersActive = !!(dq || closerId);

  const onDrop = async (id: string, columnKey: string) => {
    try {
      await post(`/deals/${id}/move`, { stage: columnKey });
      list.reload();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        // Won-gate rejection: surface the server's own required-and-failed checks.
        const checks = (
          err.blockers as Array<{ label: string; detail?: string; required?: boolean; passed?: boolean }>
        )
          .filter((c) => c.required && !c.passed)
          .map((c) => ({ label: c.label, detail: c.detail }));
        setGateBlockers(checks.length ? checks : [{ label: err.message }]);
      } else if (err instanceof ApiError) {
        toast.error('Stage change rejected', err.message);
      } else {
        toast.error('Stage change rejected', err instanceof Error ? err.message : 'Something went wrong.');
      }
      // Server truth wins: redraw so the card rolls back.
      list.reload();
      return false;
    }
  };

  const byStage: Record<string, DealRow[]> = {};
  for (const s of STAGES) byStage[s] = [];
  for (const r of rows) {
    if (!byStage[r.stage]) byStage[r.stage] = [];
    byStage[r.stage].push(r);
  }
  const columns = STAGES.map((s) => ({
    key: s,
    label: titleCase(s),
    items: byStage[s] ?? [],
    summary: money(totals[s]?.value),
    accent: s === 'won' ? 'var(--green)' : s === 'lost' ? 'var(--red)' : undefined,
  }));

  let body: ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading the pipeline…" />;
  } else if (rows.length === 0) {
    body = filtersActive ? (
      <EmptyState title="No deals match these filters" icon={<Icon name="filter" size={22} />}>
        Clear the search or closer filter to see the whole board.
      </EmptyState>
    ) : (
      <EmptyState
        title="The pipeline is empty"
        icon={<Icon name="sales" size={22} />}
        action={
          <Button variant="primary" onClick={() => setShowQueue(true)}>
            Review released quotes
          </Button>
        }
      >
        Deals are created from quotes released by Underwriting — open the review queue to pull them in.
      </EmptyState>
    );
  } else {
    body = (
      <Kanban
        columns={columns}
        getId={(d) => d.id}
        disabled={!canWrite}
        canDrag={() => canWrite}
        onOpen={(d) => navigate(`/deals/${d.id}`)}
        onDrop={onDrop}
        emptyLabel="Nothing in this stage."
        renderCard={(d) => {
          const contact = `${d.contact_first ?? ''} ${d.contact_last ?? ''}`.trim();
          const sigTone =
            d.signature_status === 'signed' ? 'green' : d.signature_status === 'declined' ? 'red' : 'amber';
          return (
            <div>
              <div className="title truncate" title={d.project_name ?? ''}>
                {d.project_name || d.deal_no}
              </div>
              <div className="sub truncate" title={contact}>
                {[d.company_name, contact].filter(Boolean).join(' · ') || '—'}
              </div>
              <div style={{ margin: '6px 0 4px' }} className="strong">
                {money(d.value)}
              </div>
              <div className="meta">
                {d.signature_status ? (
                  <Badge tone={sigTone} title="Latest contract signature status">
                    {titleCase(d.signature_status)}
                  </Badge>
                ) : null}
                {d.open_tasks ? (
                  <Badge tone="neutral" title="Open tasks">
                    {d.open_tasks} task{Number(d.open_tasks) === 1 ? '' : 's'}
                  </Badge>
                ) : null}
                {d.last_comm_at ? (
                  <Badge tone="outline" title="Last logged communication">
                    {rel(d.last_comm_at)}
                  </Badge>
                ) : null}
              </div>
              <div className="foot">
                <span className="tiny muted">Close {dateShort(d.expected_close_at)}</span>
              </div>
            </div>
          );
        }}
      />
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Sales"
        sub="Quotes released from Underwriting land here as pending review."
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={!canWrite}
            title={canWrite ? undefined : 'You do not have permission to open deals from quotes.'}
            icon={<Icon name="search" size={14} />}
            onClick={() => setShowQueue(true)}
          >
            Review released quotes
          </Button>
        }
      />

      <div className="grid grid-4">
        <Stat
          label="Pipeline value"
          value={money(sumStage(OPEN_STAGES, 'value'))}
          detail="Excludes won and lost"
          tone="accent"
        />
        <Stat
          label="Open deals"
          value={num(sumStage(OPEN_STAGES, 'count'))}
          detail="Sent, negotiating, contract, awaiting signature"
        />
        <Stat
          label="Won"
          value={money(totals.won?.value)}
          detail={`${num(totals.won?.count ?? 0)} closed won`}
          tone="good"
        />
        <Stat
          label="Lost"
          value={num(totals.lost?.count ?? 0)}
          detail={`${money(totals.lost?.value)} lost value`}
          tone="bad"
        />
      </div>

      <div className="filters">
        <Input
          type="search"
          aria-label="Search deals"
          placeholder="Search project, deal no, contact, company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <Select
          aria-label="Closer"
          value={closerId}
          onChange={(e) => setCloserId(e.target.value)}
          options={[
            { value: '', label: 'Any closer' },
            ...(roster.data?.rows ?? []).map((r) => ({ value: r.id, label: r.name })),
          ]}
        />
        {filtersActive ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQ('');
              setCloserId('');
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {roster.error ? <ErrorState error={roster.error} onRetry={roster.reload} /> : null}
      {/* A failed refresh keeps the previous board on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}

      {showQueue ? (
        <ReviewQueueModal
          canWrite={canWrite}
          projectTypes={(config.data?.wonGates ?? []).map((g) => g.project_type)}
          onClose={() => setShowQueue(false)}
          onCreated={(dealId) => navigate(`/deals/${dealId}`)}
        />
      ) : null}

      {gateBlockers ? (
        <Modal
          title="Won requirements not met"
          sub="The server blocked this move. Clear these requirements before marking the deal Won."
          onClose={() => setGateBlockers(null)}
          size="sm"
          footer={
            <Button variant="primary" onClick={() => setGateBlockers(null)}>
              Got it
            </Button>
          }
        >
          <BlockerList items={gateBlockers} />
        </Modal>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review queue: released quotes without a deal yet                   */
/* ------------------------------------------------------------------ */

interface QueueRow {
  estimate_id: string;
  version: number;
  bid_no: string;
  trade: string | null;
  contact_name: string | null;
  company_name: string | null;
  scope_summary: string | null;
  calc: { sellingPrice?: number; grossMargin?: number | null };
  [key: string]: any;
}

function ReviewQueueModal({
  canWrite,
  projectTypes,
  onClose,
  onCreated,
}: {
  canWrite: boolean;
  projectTypes: string[];
  onClose: () => void;
  onCreated: (dealId: string) => void;
}) {
  const queue = useFetch<{ rows: QueueRow[] }>('/deals/review-queue');

  let body: ReactNode;
  if (queue.error) {
    body = <ErrorState error={queue.error} onRetry={queue.reload} />;
  } else if (queue.loading && !queue.data) {
    body = <Loading label="Loading released quotes…" />;
  } else if ((queue.data?.rows ?? []).length === 0) {
    body = (
      <EmptyState title="The review queue is clear" icon={<Icon name="check" size={22} />}>
        Every quote released by Underwriting already has a deal.
      </EmptyState>
    );
  } else {
    body = (
      <div className="stack">
        {(queue.data?.rows ?? []).map((r) => (
          <QueueRowCard
            key={r.estimate_id}
            row={r}
            canWrite={canWrite}
            projectTypes={projectTypes}
            onCreated={onCreated}
          />
        ))}
      </div>
    );
  }

  return (
    <Modal
      title="Review released quotes"
      sub="Open a deal to start tracking this quote through Sales. The first stage is always Review."
      size="lg"
      onClose={onClose}
    >
      {body}
    </Modal>
  );
}

function QueueRowCard({
  row,
  canWrite,
  projectTypes,
  onCreated,
}: {
  row: QueueRow;
  canWrite: boolean;
  projectTypes: string[];
  onCreated: (dealId: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [projectName, setProjectName] = useState((row.scope_summary ?? '').slice(0, 120));
  const [projectType, setProjectType] = useState(projectTypes[0] ?? 'standard');
  const [expectedClose, setExpectedClose] = useState('');

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await post(`/deals/from-estimate/${row.estimate_id}`, {
        projectName: projectName.trim() || undefined,
        projectType,
        expectedCloseAt: dateToMs(expectedClose),
      });
      toast.success('Deal opened', `${res.deal.deal_no} is ready for review.`);
      onCreated(res.deal.id);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card">
      <div className="card-pad">
        <div className="row wrap">
          <b className="mono">{row.bid_no}</b>
          {row.trade ? <Badge tone="blue">{TRADE_LABELS[row.trade] ?? titleCase(row.trade)}</Badge> : null}
          <Badge tone="neutral" title="Quote version">
            v{row.version}
          </Badge>
          <span className="spacer" />
          <span className="strong">{money(row.calc?.sellingPrice)}</span>
          <span className={`small ${Number(row.calc?.grossMargin) >= 0.25 ? '' : 'muted'}`}>
            GM {pct(row.calc?.grossMargin)}
          </span>
        </div>
        <div className="sub small muted truncate">
          {[row.company_name, row.contact_name].filter(Boolean).join(' · ') || '—'}
        </div>
        <div className="small truncate" title={row.scope_summary ?? ''}>
          {row.scope_summary || '—'}
        </div>

        {open ? (
          <div className="stack" style={{ marginTop: 10 }}>
            {error ? (
              <div className="error-state" role="alert">
                {error}
              </div>
            ) : null}
            <div className="form-grid">
              <Input
                label="Project name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={row.scope_summary ?? row.bid_no}
              />
              <Select
                label="Project type"
                value={projectType}
                onChange={(e) => setProjectType(e.target.value)}
                options={projectTypes.length ? projectTypes.map((t) => ({ value: t, label: titleCase(t) })) : [{ value: 'standard', label: 'Standard' }]}
              />
              <Input
                label="Expected close"
                type="date"
                value={expectedClose}
                onChange={(e) => setExpectedClose(e.target.value)}
              />
            </div>
            <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
              <Button size="sm" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" loading={pending} onClick={submit}>
                Open deal
              </Button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="spacer" />
            <Button
              size="sm"
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : 'You do not have permission to open deals.'}
              onClick={() => setOpen(true)}
            >
              Open deal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
