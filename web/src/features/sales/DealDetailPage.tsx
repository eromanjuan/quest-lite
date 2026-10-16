import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { post, put, ApiError } from '../../lib/api';
import { useAction, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
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
  Field,
  Input,
  KeyValue,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Segmented,
  Select,
  Tabs,
  TextArea,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  dateShort,
  dateTime,
  fromLocalInputValue,
  isOverdue,
  money2,
  pct,
  pctRaw,
  rel,
  titleCase,
  TRADE_LABELS,
} from '../../lib/format';

/**
 * Client-side mirror of the transitions in server/routes/deals.ts.
 * The SERVER re-validates every move (409 on a bad transition, 422 on an
 * unmet Won gate) — this map only decides which buttons render.
 */
const TRANSITIONS: Record<string, string[]> = {
  review: ['estimate_sent', 'lost'],
  estimate_sent: ['negotiating', 'contract_sent', 'lost'],
  negotiating: ['estimate_sent', 'contract_sent', 'lost'],
  contract_sent: ['waiting_to_sign', 'negotiating', 'lost'],
  waiting_to_sign: ['contract_sent', 'won', 'lost'],
  won: [],
  lost: ['review'],
};

const STAGE_TONES: Record<string, Tone> = {
  review: 'amber',
  estimate_sent: 'blue',
  negotiating: 'violet',
  contract_sent: 'accent',
  waiting_to_sign: 'blue',
  won: 'green',
  lost: 'red',
};

const TASK_TYPES = ['follow_up', 'call', 'text', 'email', 'site_visit', 'document', 'task'];
const DELIVERY_METHODS = ['email', 'in_person', 'portal', 'other'];
const DEPOSIT_STATUSES = ['not_required', 'due', 'received', 'cleared'];

const GATE_FLAGS: Array<[string, string]> = [
  ['require_contract_signed', 'Signed contract'],
  ['require_deposit', 'Deposit cleared'],
  ['require_insurance', 'Insurance received'],
  ['require_compliance', 'Compliance documents'],
  ['require_approval', 'Internal approvals'],
];

interface WonCheck {
  key: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail?: string;
}

interface WonGate {
  ok: boolean;
  config: Record<string, any>;
  checks: WonCheck[];
}

interface DealRow {
  id: string;
  deal_no: string;
  project_name: string | null;
  project_address: string | null;
  project_type: string | null;
  trade: string | null;
  bid_trade?: string | null;
  value: number | null;
  stage: string;
  closer_name: string | null;
  contact_first: string | null;
  contact_last: string | null;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  created_at: number;
  expected_close_at: number | null;
  won_at: number | null;
  lost_reason: string | null;
  quote_sent_at: number | null;
  last_contact_at: number | null;
  handoff_project_id: string | null;
  [key: string]: any;
}

interface Proposal {
  id: string;
  version: number;
  status: string;
  title: string;
  pricing_mode: string;
  subtotal: number;
  total: number;
  delivery_method: string | null;
  sent_at: number | null;
  payment_terms: string | null;
  valid_days: number | null;
  [key: string]: any;
}

interface DrawItem {
  seq: number;
  milestone: string;
  trigger: string;
  pct: number;
  amount: number;
  condition: string | null;
  [key: string]: any;
}

interface Contract {
  id: string;
  version: number;
  amount: number;
  status: string;
  signature_status: string;
  provider: string | null;
  signed_at: number | null;
  signature_ref: string | null;
  [key: string]: any;
}

interface Deposit {
  id: string;
  amount: number;
  status: string;
  due_at: number | null;
  method: string | null;
  reference: string | null;
  [key: string]: any;
}

interface ComplianceItem {
  id: string;
  key: string;
  name: string;
  required: number;
  received: number;
  [key: string]: any;
}

interface Estimate {
  id: string;
  version: number;
  status: string;
  calc: { sellingPrice?: number; grossMargin?: number | null; netMargin?: number | null; hardCost?: number };
  [key: string]: any;
}

interface DealTask {
  id: string;
  title: string;
  type: string;
  due_at: number | null;
  assignee_name: string | null;
  [key: string]: any;
}

interface ProjectRow {
  id: string;
  project_no: string;
  name: string;
  [key: string]: any;
}

interface DealBundle {
  deal: DealRow;
  proposals: Proposal[];
  drawSchedule: { version: number; items: DrawItem[] } | null;
  contracts: Contract[];
  deposit: Deposit | null;
  compliance: ComplianceItem[];
  estimate: Estimate | null;
  project: ProjectRow | null;
  tasks: DealTask[];
  gate: WonGate;
}

interface RosterRow {
  id: string;
  name: string;
  [key: string]: any;
}

interface ConfigData {
  wonGates?: Array<{ project_type: string; [key: string]: any }>;
  [key: string]: any;
}

/** Date inputs hand back "YYYY-MM-DD"; pin it to local midnight so the day survives formatting. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

/** A 422 from the Won endpoints carries gate.checks; ApiError.blockers normalises it. */
function gateBlockersOf(err: ApiError): Array<{ label: string; detail?: string }> {
  const checks = err.blockers as unknown as WonCheck[];
  const failed = checks.filter((c) => c.required && !c.passed).map((c) => ({ label: c.label, detail: c.detail }));
  // Never show an empty modal: fall back to the plain server message.
  return failed.length ? failed : [{ label: err.message }];
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

export default function DealDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = useAuth();

  const bundle = useFetch<DealBundle>(id ? `/deals/${id}` : null, [id]);
  const config = useFetch<ConfigData>('/config');
  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');

  const [tab, setTab] = useState('overview');
  const [gateBlockers, setGateBlockers] = useState<Array<{ label: string; detail?: string }> | null>(null);
  const [repricingOpen, setRepricingOpen] = useState(false);
  const [wonConfirmOpen, setWonConfirmOpen] = useState(false);
  const [wonPending, setWonPending] = useState(false);
  const [wonNotice, setWonNotice] = useState<{ kind: 'success' | 'info'; message: string; projectId?: string } | null>(null);

  const canWrite = can('deal.write');
  const canMarkWon = can('deal.mark_won');
  const canReprice = can('deal.request_repricing');

  const reload = bundle.reload;

  const moveStage = async (to: string) => {
    try {
      await post(`/deals/${id}/move`, { stage: to });
      toast.success('Stage updated', `Moved to ${titleCase(to)}.`);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setGateBlockers(gateBlockersOf(err));
        reload();
      } else if (err instanceof ApiError) {
        toast.error('Stage change rejected', err.message);
      } else {
        toast.error('Stage change rejected', errMessage(err));
      }
    }
  };

  const markWon = async () => {
    setWonPending(true);
    try {
      const res = await post(`/deals/${id}/won`, {});
      setWonConfirmOpen(false);
      if (res.alreadyHandedOff) {
        // Handoff is idempotent — surface it instead of pretending something happened.
        const note = res.note ?? 'Handoff is idempotent — no duplicate records were created.';
        setWonNotice({ kind: 'info', message: note, projectId: res.project?.id });
        toast.info('Already handed off', note);
      } else {
        const message = res.project ? `Handed off to ${res.project.project_no}.` : 'Deal marked Won.';
        setWonNotice({ kind: 'success', message, projectId: res.project?.id });
        toast.success('Deal marked Won', message);
      }
      reload();
    } catch (err) {
      setWonConfirmOpen(false);
      if (err instanceof ApiError && err.status === 422) {
        setGateBlockers(gateBlockersOf(err));
        reload();
      } else if (err instanceof ApiError) {
        toast.error('Could not mark Won', err.message);
      } else {
        toast.error('Could not mark Won', errMessage(err));
      }
    } finally {
      setWonPending(false);
    }
  };

  if (bundle.error && !bundle.data) {
    return (
      <div className="stack">
        <PageHead title="Deal" actions={<LinkButton to="/sales" size="sm">← Sales</LinkButton>} />
        <ErrorState error={bundle.error} onRetry={bundle.reload} />
      </div>
    );
  }
  if (!bundle.data) return <Loading label="Loading deal…" />;

  const { deal, proposals, drawSchedule, contracts, deposit, compliance, estimate, project, tasks, gate } = bundle.data;
  const contactName = `${deal.contact_first ?? ''} ${deal.contact_last ?? ''}`.trim() || '—';
  const stage = String(deal.stage ?? 'review');
  const advanceTargets = (TRANSITIONS[stage] ?? []).filter((s) => s !== 'won');

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'proposal', label: 'Proposals', count: proposals.length },
    { key: 'draws', label: 'Draws', count: drawSchedule?.items.length ?? 0 },
    { key: 'contract', label: 'Contract', count: contracts.length },
    { key: 'compliance', label: 'Compliance', count: compliance.length },
    { key: 'won-gate', label: 'Won gate' },
    { key: 'tasks', label: 'Tasks', count: tasks.length },
  ];
  const PANELS = tabs.map((t) => t.key);

  const renderPanel = (key: string): ReactNode => {
    switch (key) {
      case 'overview':
        return <OverviewPanel data={bundle.data!} />;
      case 'proposal':
        return <ProposalPanel data={bundle.data!} reload={reload} canWrite={canWrite} />;
      case 'draws':
        return <DrawsPanel data={bundle.data!} reload={reload} canWrite={canWrite} />;
      case 'contract':
        return <ContractPanel data={bundle.data!} reload={reload} canWrite={canWrite} />;
      case 'compliance':
        return <CompliancePanel data={bundle.data!} reload={reload} canWrite={canWrite} />;
      case 'won-gate':
        return <WonGatePanel data={bundle.data!} canMarkWon={canMarkWon} onMarkWon={() => setWonConfirmOpen(true)} />;
      case 'tasks':
        return <TasksPanel data={bundle.data!} reload={reload} roster={roster.data?.rows ?? []} />;
      default:
        return null;
    }
  };

  return (
    <div className="stack">
      <PageHead
        title={
          <span className="row wrap">
            <span className="mono">{deal.deal_no ?? 'Deal'}</span>
            <span className="muted">·</span>
            <span>{deal.project_name || '—'}</span>
          </span>
        }
        sub={`${contactName}${deal.company_name ? ` · ${deal.company_name}` : ''} · Closer: ${deal.closer_name ?? '—'}`}
        actions={
          <div className="row wrap">
            <LinkButton to="/sales" size="sm">
              ← Sales
            </LinkButton>
            {canWrite
              ? advanceTargets.map((s) => (
                  <Button key={s} size="sm" onClick={() => moveStage(s)}>
                    {s === 'lost' ? 'Mark lost' : `Move to ${titleCase(s)}`}
                  </Button>
                ))
              : null}
            {canMarkWon && stage !== 'won' && stage !== 'lost' ? (
              <Button size="sm" variant="success" onClick={() => setWonConfirmOpen(true)}>
                Mark Won
              </Button>
            ) : null}
            {canReprice && stage !== 'won' ? (
              <Button size="sm" onClick={() => setRepricingOpen(true)}>
                Request re-pricing
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="row wrap">
          <Badge tone={STAGE_TONES[stage] ?? 'neutral'}>{titleCase(stage)}</Badge>
          <Badge tone="accent">{money2(deal.value)}</Badge>
          {deal.bid_no ? <Badge tone="violet">{deal.bid_no}</Badge> : null}
          {deal.expected_close_at ? <Badge tone="outline">Close {dateShort(deal.expected_close_at)}</Badge> : null}
          {deal.won_at ? <Badge tone="green">Won {dateShort(deal.won_at)}</Badge> : null}
          {deal.handoff_project_id ? <Badge tone="green">Handed off</Badge> : null}
        </div>
      </PageHead>

      {wonNotice ? (
        <div className={wonNotice.kind === 'success' ? 'success-state' : 'info-state'} role="status">
          <div className="row wrap">
            <span className="grow">{wonNotice.message}</span>
            {wonNotice.projectId ? (
              <LinkButton to={`/projects/${wonNotice.projectId}`} size="sm">
                Open project file
              </LinkButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {config.error || roster.error ? (
        <ErrorState
          error={config.error ?? roster.error}
          onRetry={() => {
            if (config.error) config.reload();
            if (roster.error) roster.reload();
          }}
        />
      ) : null}

      <div className="split-wide">
        <div className="stack">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          {/*
            Panels stay mounted (hidden) so half-typed editors — a proposal,
            a draw schedule — survive a tab switch.
          */}
          <div className="stack">
            {PANELS.map((key) => (
              <div key={key} style={tab === key ? undefined : { display: 'none' }}>
                {renderPanel(key)}
              </div>
            ))}
          </div>
        </div>

        <aside className="stack">
          <Card
            title="Won gate"
            sub={gate.ok ? 'All requirements met' : `${gate.checks.filter((c) => c.required && !c.passed).length} required outstanding`}
          >
            <BlockerList items={gate.checks.map((c) => ({ label: c.label, passed: c.passed }))} />
            <Button
              block
              variant={gate.ok ? 'success' : 'default'}
              disabled={!canMarkWon || stage === 'won' || stage === 'lost'}
              title={canMarkWon ? undefined : 'You do not have permission to mark deals Won.'}
              onClick={() => setWonConfirmOpen(true)}
            >
              Mark Won
            </Button>
          </Card>

          <DepositCard data={bundle.data!} reload={reload} canWrite={canWrite} />

          <Card title="Last contact / open tasks">
            <KeyValue
              items={[
                ['Last contact', rel(deal.last_contact_at)],
                ['Open tasks', String(tasks.length)],
                ['Phone', deal.phone || '—'],
                ['Email', deal.email || '—'],
              ]}
            />
          </Card>
        </aside>
      </div>

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

      {wonConfirmOpen ? (
        <ConfirmDialog
          title="Mark this deal Won?"
          tone="success"
          confirmLabel="Mark Won"
          loading={wonPending}
          message="The server re-runs the Won gate. If it passes, the deal moves to Won and Production receives the project, jobs and draw schedule. Handoff is idempotent — re-running it never creates duplicates."
          onConfirm={markWon}
          onCancel={() => setWonConfirmOpen(false)}
        />
      ) : null}

      {repricingOpen ? (
        <RepricingModal dealId={id} dealNo={deal.deal_no} onClose={() => setRepricingOpen(false)} onDone={() => { setRepricingOpen(false); reload(); }} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function OverviewPanel({ data }: { data: DealBundle }) {
  const { deal, estimate, project } = data;
  const trade = deal.bid_trade ?? deal.trade;
  return (
    <div className="stack">
      <Card title="Deal facts">
        <KeyValue
          items={[
            ['Project name', deal.project_name || '—'],
            ['Project type', deal.project_type ? titleCase(deal.project_type) : '—'],
            ['Address', deal.project_address || '—'],
            ['Trade', trade ? (TRADE_LABELS[trade] ?? titleCase(trade)) : '—'],
            ['Created', dateShort(deal.created_at)],
            ['Expected close', dateShort(deal.expected_close_at)],
            ['Won at', dateShort(deal.won_at)],
            ['Lost reason', deal.lost_reason || '—'],
          ]}
        />
      </Card>

      <Card title="Released quote">
        {estimate ? (
          <div className="stack">
            <KeyValue
              items={[
                ['Version', `v${estimate.version}`],
                ['Selling price', money2(estimate.calc?.sellingPrice)],
                ['Gross margin', pct(estimate.calc?.grossMargin)],
                ['Net margin', pct(estimate.calc?.netMargin)],
              ]}
            />
            <Callout tone="grey">
              This quote is immutable in Sales. Closers cannot change price — pricing changes go back to
              Underwriting through “Request re-pricing”.
            </Callout>
          </div>
        ) : (
          <EmptyState title="No released quote" icon={<Icon name="estimate" size={22} />}>
            The quote is with Underwriting — nothing here can be priced until it is released again.
          </EmptyState>
        )}
      </Card>

      {project ? (
        <div className="success-state">
          <div className="row wrap">
            <span className="grow">
              Handed off to Production as <span className="mono">{project.project_no}</span>.
            </span>
            <LinkButton to={`/projects/${project.id}`} size="sm">
              Open project file
            </LinkButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Proposals                                                           */
/* ------------------------------------------------------------------ */

function ProposalPanel({ data, reload, canWrite }: { data: DealBundle; reload: () => void; canWrite: boolean }) {
  const { deal, proposals, estimate } = data;
  const [buildOpen, setBuildOpen] = useState(false);
  const [sendFor, setSendFor] = useState<Proposal | null>(null);

  const statusTone = (s: string): Tone => (s === 'sent' ? 'green' : s === 'draft' ? 'amber' : 'neutral');

  return (
    <Card
      title="Proposals"
      sub="A sent proposal is never mutated — building a new version supersedes every prior draft and sent one."
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={!canWrite || !estimate}
          title={
            !estimate
              ? 'A released quote is required before a proposal can be built.'
              : !canWrite
                ? 'You do not have permission to build proposals.'
                : undefined
          }
          icon={<Icon name="plus" size={14} />}
          onClick={() => setBuildOpen(true)}
        >
          Build new proposal
        </Button>
      }
    >
      <div className="stack">
        {!estimate ? (
          <div className="warn-state">
            No released quote exists for this deal — a proposal can only be built once Underwriting releases one.
          </div>
        ) : null}

        {proposals.length === 0 ? (
          <EmptyState title="No proposals yet" icon={<Icon name="file" size={22} />}>
            Build the first proposal from the released quote.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table tbl">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th>Delivery</th>
                  <th>Sent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">v{p.version}</td>
                    <td>
                      <Badge tone={statusTone(p.status)}>{titleCase(p.status)}</Badge>
                    </td>
                    <td className="num">{money2(p.total)}</td>
                    <td>{p.delivery_method ? titleCase(p.delivery_method) : '—'}</td>
                    <td>{dateTime(p.sent_at)}</td>
                    <td className="right">
                      {p.status === 'draft' && canWrite ? (
                        <Button size="sm" onClick={() => setSendFor(p)}>
                          Mark sent
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Callout tone="grey">
          E-signature delivery is not connected in this deployment. Contracts are recorded manually once signed.
        </Callout>
      </div>

      {buildOpen ? (
        <BuildProposalModal
          dealId={deal.id}
          defaultTotal={estimate?.calc?.sellingPrice}
          onClose={() => setBuildOpen(false)}
          onDone={() => {
            setBuildOpen(false);
            reload();
          }}
        />
      ) : null}
      {sendFor ? (
        <SendProposalModal
          proposal={sendFor}
          onClose={() => setSendFor(null)}
          onDone={() => {
            setSendFor(null);
            reload();
          }}
        />
      ) : null}
    </Card>
  );
}

interface OptionRow {
  key: string;
  label: string;
  price: string;
  scope: string;
}

function BuildProposalModal({
  dealId,
  defaultTotal,
  onClose,
  onDone,
}: {
  dealId: string;
  defaultTotal: number | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'lump' | 'by_trade'>('lump');
  const [options, setOptions] = useState<OptionRow[]>([{ key: 'base', label: 'Base scope', price: '', scope: '' }]);
  const [subtotal, setSubtotal] = useState('');
  const [total, setTotal] = useState(defaultTotal != null ? String(defaultTotal) : '');
  const [terms, setTerms] = useState('');
  const [validDays, setValidDays] = useState('30');

  const setOpt = (i: number, patch: Partial<OptionRow>) =>
    setOptions((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const action = useAction(() =>
    post(`/deals/${dealId}/proposals`, {
      title: title.trim() || undefined,
      pricingMode: mode,
      options: options
        .filter((o) => o.label.trim() || o.price !== '')
        .map((o) => ({ key: o.key.trim() || 'option', label: o.label.trim(), price: Number(o.price) || 0, scope: o.scope })),
      subtotal: Number(subtotal) || 0,
      total: Number(total) || 0,
      paymentTerms: terms,
      validDays: Math.min(365, Math.max(1, Math.round(Number(validDays) || 30))),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Proposal built', `Proposal v${res.proposal.version} is ready to send.`);
      onDone();
    }
    // Errors stay in the dialog: action.error.message is rendered above the form.
  };

  return (
    <Modal
      title="Build new proposal"
      sub="Every prior draft and sent version is superseded — a sent proposal is never edited in place."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} onClick={submit}>
            Build proposal
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}

        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Proposal" />

        <Field label="Pricing mode">
          <Segmented
            options={[
              { value: 'lump', label: 'Lump sum' },
              { value: 'by_trade', label: 'By trade' },
            ]}
            value={mode}
            onChange={(v) => setMode(v)}
          />
        </Field>

        <div className="stack">
          <div className="row">
            <b className="grow">Options</b>
            <Button
              size="sm"
              icon={<Icon name="plus" size={14} />}
              onClick={() => setOptions((o) => [...o, { key: `opt${o.length + 1}`, label: '', price: '', scope: '' }])}
            >
              Add option
            </Button>
          </div>
          {options.map((o, i) => (
            <div key={i} className="card">
              <div className="card-pad stack">
                <div className="form-grid">
                  <Input
                    label="Key"
                    className="input-sm"
                    value={o.key}
                    onChange={(e) => setOpt(i, { key: e.target.value })}
                    placeholder="base"
                  />
                  <Input
                    label="Label"
                    className="input-sm"
                    value={o.label}
                    onChange={(e) => setOpt(i, { label: e.target.value })}
                    placeholder="Base scope"
                  />
                  <Input
                    label="Price"
                    className="input-sm"
                    type="number"
                    min={0}
                    step="0.01"
                    value={o.price}
                    onChange={(e) => setOpt(i, { price: e.target.value })}
                  />
                </div>
                <TextArea
                  label="Scope note"
                  className="input-sm"
                  rows={2}
                  value={o.scope}
                  onChange={(e) => setOpt(i, { scope: e.target.value })}
                />
                {options.length > 1 ? (
                  <div className="row">
                    <span className="spacer" />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOptions((rows) => rows.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="form-grid">
          <Input
            label="Subtotal"
            type="number"
            min={0}
            step="0.01"
            value={subtotal}
            onChange={(e) => setSubtotal(e.target.value)}
          />
          <Input
            label="Total"
            required
            type="number"
            min={0}
            step="0.01"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
          />
          <Input
            label="Valid for (days)"
            type="number"
            min={1}
            max={365}
            value={validDays}
            onChange={(e) => setValidDays(e.target.value)}
          />
        </div>
        <TextArea
          label="Payment terms"
          rows={3}
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder="50% at signing, balance on substantial completion."
        />
      </div>
    </Modal>
  );
}

function SendProposalModal({
  proposal,
  onClose,
  onDone,
}: {
  proposal: Proposal;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [method, setMethod] = useState('email');
  const [followUp, setFollowUp] = useState('');
  const [note, setNote] = useState('');

  const action = useAction(() =>
    post(`/deals/proposals/${proposal.id}/send`, {
      deliveryMethod: method,
      note: note.trim() || undefined,
      followUpAt: dateToMs(followUp),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Proposal sent', `v${proposal.version} is recorded as sent.`);
      onDone();
    }
    // A 409 (already sent / superseded) renders inline below.
  };

  return (
    <Modal
      title={`Mark proposal v${proposal.version} sent`}
      sub={proposal.title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} onClick={submit}>
            Mark sent
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Select
          label="Delivery method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={DELIVERY_METHODS.map((m) => ({ value: m, label: titleCase(m) }))}
        />
        <Input
          label="Follow-up date"
          type="date"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          hint="Creates a follow-up task when set."
        />
        <TextArea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Draw schedule                                                       */
/* ------------------------------------------------------------------ */

interface DrawEditorRow {
  milestone: string;
  trigger: string;
  pct: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function DrawsPanel({ data, reload, canWrite }: { data: DealBundle; reload: () => void; canWrite: boolean }) {
  const { deal, drawSchedule } = data;
  const toast = useToast();
  const [rows, setRows] = useState<DrawEditorRow[]>([{ milestone: '', trigger: '', pct: '' }]);

  const setRow = (i: number, patch: Partial<DrawEditorRow>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // Client-side mirror of the server rule: percentages must total exactly 100.
  const sumPct = round2(rows.reduce((a, r) => a + (Number(r.pct) || 0), 0));
  const exact = Math.abs(sumPct - 100) < 0.005;
  const complete = rows.every((r) => r.milestone.trim().length > 0) && rows.length >= 1;

  const action = useAction(() =>
    put(`/deals/${deal.id}/draw-schedule`, {
      items: rows.map((r) => ({
        milestone: r.milestone.trim(),
        trigger: r.trigger.trim(),
        pct: Number(r.pct) || 0,
      })),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Draw schedule saved', `${pctRaw(res.sumPct)} across ${res.items.length} draws.`);
      setRows([{ milestone: '', trigger: '', pct: '' }]);
      reload();
    }
    // A 422 ("must total exactly 100") renders inline below.
  };

  const items = drawSchedule?.items ?? [];
  const schedSum = round2(items.reduce((a, i) => a + (Number(i.pct) || 0), 0));
  const schedTotal = items.reduce((a, i) => a + (Number(i.amount) || 0), 0);

  return (
    <div className="stack">
      <Card title="Current schedule" sub={drawSchedule ? `Version v${drawSchedule.version} · allocated against ${money2(deal.value)}` : 'No schedule yet'}>
        {items.length === 0 ? (
          <EmptyState title="No draw schedule" icon={<Icon name="dollar" size={22} />}>
            Create the first schedule below — it carries forward to the project at handoff.
          </EmptyState>
        ) : (
          <div className="stack">
            <div className="table-wrap">
              <table className="table tbl">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Milestone</th>
                    <th>Trigger</th>
                    <th className="num">%</th>
                    <th className="num">Amount</th>
                    <th>Condition</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.seq}>
                      <td className="num">{it.seq}</td>
                      <td>{it.milestone || '—'}</td>
                      <td>{it.trigger || '—'}</td>
                      <td className="num">{pctRaw(it.pct)}</td>
                      <td className="num">{money2(it.amount)}</td>
                      <td>{it.condition || '—'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="right strong">
                      Total
                    </td>
                    <td className="num strong">{pctRaw(schedSum)}</td>
                    <td className="num strong">{money2(schedTotal)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {schedSum !== 100 ? (
              <div className="warn-state" role="alert">
                Percentages total {pctRaw(schedSum)} — a schedule must total exactly 100%.
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Card
        title="New schedule"
        sub={`Saving supersedes the current schedule and allocates against the contract value of ${money2(deal.value)}.`}
      >
        <div className="stack">
          {action.error ? (
            <div className="error-state" role="alert">
              {action.error.message}
            </div>
          ) : null}

          {rows.map((r, i) => (
            <div key={i} className="form-grid">
              <Input
                label="Milestone"
                className="input-sm"
                required
                value={r.milestone}
                onChange={(e) => setRow(i, { milestone: e.target.value })}
                placeholder="Mobilization"
              />
              <Input
                label="Trigger"
                className="input-sm"
                value={r.trigger}
                onChange={(e) => setRow(i, { trigger: e.target.value })}
                placeholder="At contract signing"
              />
              <Input
                label="%"
                className="input-sm"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={r.pct}
                onChange={(e) => setRow(i, { pct: e.target.value })}
              />
              <div className="field">
                <label aria-hidden="true">&nbsp;</label>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rows.length <= 1}
                  onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}

          <div className="row wrap">
            <Button
              size="sm"
              icon={<Icon name="plus" size={14} />}
              onClick={() => setRows((r) => [...r, { milestone: '', trigger: '', pct: '' }])}
            >
              Add draw
            </Button>
            <span className="spacer" />
            <span className="small">
              Running total:{' '}
              <b style={{ color: exact ? 'var(--green)' : 'var(--red)' }}>{pctRaw(sumPct)} / 100%</b>
            </span>
          </div>
          {!exact ? (
            <div className="small" style={{ color: 'var(--red)' }}>
              The percentages must total exactly 100% — the server rejects anything else.
            </div>
          ) : null}

          <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              disabled={!canWrite || !exact || !complete}
              title={!canWrite ? 'You do not have permission to change the draw schedule.' : undefined}
              loading={action.pending}
              onClick={submit}
            >
              Save schedule
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

function ContractPanel({ data, reload, canWrite }: { data: DealBundle; reload: () => void; canWrite: boolean }) {
  const { deal, contracts } = data;
  const [addOpen, setAddOpen] = useState(false);
  const [signFor, setSignFor] = useState<Contract | null>(null);

  const sigTone = (s: string): Tone => (s === 'signed' ? 'green' : s === 'declined' ? 'red' : 'amber');

  return (
    <Card
      title="Contracts"
      sub="E-signature delivery is not connected in this deployment. No envelope is dispatched — signing is recorded manually."
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={!canWrite}
          title={canWrite ? undefined : 'You do not have permission to add contracts.'}
          icon={<Icon name="plus" size={14} />}
          onClick={() => setAddOpen(true)}
        >
          Add contract version
        </Button>
      }
    >
      {contracts.length === 0 ? (
        <EmptyState title="No contract yet" icon={<Icon name="file" size={22} />}>
          Add the first contract version once the agreement is drafted.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table tbl">
            <thead>
              <tr>
                <th>Version</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Signature</th>
                <th>Signed at</th>
                <th>Provider</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td className="mono">v{c.version}</td>
                  <td className="num">{money2(c.amount)}</td>
                  <td>
                    <Badge tone={c.status === 'signed' ? 'green' : 'neutral'}>{titleCase(c.status)}</Badge>
                  </td>
                  <td>
                    <Badge tone={sigTone(c.signature_status)}>{titleCase(c.signature_status)}</Badge>
                  </td>
                  <td>{dateTime(c.signed_at)}</td>
                  <td>{c.provider || 'none'}</td>
                  <td className="right">
                    {c.signature_status !== 'signed' && canWrite ? (
                      <Button size="sm" onClick={() => setSignFor(c)}>
                        Record signature
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen ? (
        <AddContractModal
          dealId={deal.id}
          defaultAmount={deal.value}
          nextVersion={Math.max(0, ...contracts.map((c) => c.version)) + 1}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            reload();
          }}
        />
      ) : null}
      {signFor ? (
        <SignContractModal
          contract={signFor}
          onClose={() => setSignFor(null)}
          onDone={() => {
            setSignFor(null);
            reload();
          }}
        />
      ) : null}
    </Card>
  );
}

function AddContractModal({
  dealId,
  defaultAmount,
  nextVersion,
  onClose,
  onDone,
}: {
  dealId: string;
  defaultAmount: number | null;
  nextVersion: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(defaultAmount != null ? String(defaultAmount) : '');
  const [version, setVersion] = useState(String(nextVersion));

  const action = useAction(() =>
    post(`/deals/${dealId}/contract`, {
      amount: Number(amount) || 0,
      version: Math.max(1, Math.round(Number(version) || 1)),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Contract added', `Contract v${res.contract.version} recorded.`);
      onDone();
    }
  };

  return (
    <Modal
      title="Add contract version"
      sub="The contract starts as draft and unsigned — record the signature separately."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} onClick={submit}>
            Add contract
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <div className="form-grid">
          <Input
            label="Amount"
            required
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Input
            label="Version"
            required
            type="number"
            min={1}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

function SignContractModal({
  contract,
  onClose,
  onDone,
}: {
  contract: Contract;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [signed, setSigned] = useState(true);
  const [signatureRef, setSignatureRef] = useState('');
  const [provider, setProvider] = useState('none');

  const action = useAction(() =>
    post(`/deals/contracts/${contract.id}/sign`, {
      signed,
      signatureRef: signatureRef.trim() || undefined,
      provider: provider.trim() || 'none',
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success(signed ? 'Signature recorded' : 'Decline recorded', `Contract v${contract.version} updated.`);
      onDone();
    }
  };

  return (
    <Modal
      title={`Record signature — contract v${contract.version}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Callout tone="grey">
          No e-sign envelope is dispatched from this system — record what happened outside it. Signing moves the
          deal to Waiting to sign; declining does not.
        </Callout>
        <Checkbox
          label="Contract was signed"
          checked={signed}
          onChange={(e) => setSigned(e.target.checked)}
        />
        <Input
          label="Signature reference"
          value={signatureRef}
          onChange={(e) => setSignatureRef(e.target.value)}
          placeholder="Wet-ink copy filed 2026-03-04"
        />
        <Input
          label="Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          hint="Defaults to none — no e-sign provider is connected."
        />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Compliance                                                          */
/* ------------------------------------------------------------------ */

function CompliancePanel({ data, reload, canWrite }: { data: DealBundle; reload: () => void; canWrite: boolean }) {
  const { deal, compliance } = data;
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (item: ComplianceItem) => {
    setBusy(item.id);
    try {
      const received = item.received !== 1;
      await post(`/deals/${deal.id}/compliance/${item.key}`, { received });
      toast.success(received ? 'Marked received' : 'Cleared', item.name);
      reload();
    } catch (err) {
      toast.error('Update failed', err instanceof ApiError ? err.message : errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (compliance.length === 0) {
    return (
      <Card title="Compliance">
        <EmptyState title="No compliance checklist" icon={<Icon name="check" size={22} />}>
          The checklist is seeded when the deal is opened from a quote.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card title="Compliance" sub="Required documents gate the Won handoff — the server re-checks every one of them.">
      <div className="table-wrap">
        <table className="table tbl">
          <thead>
            <tr>
              <th>Document</th>
              <th>Requirement</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {compliance.map((c) => (
              <tr key={c.id}>
                <td>{c.name || c.key}</td>
                <td>
                  {c.required === 1 ? <Badge tone="amber">Required</Badge> : <Badge tone="outline">Optional</Badge>}
                </td>
                <td>
                  {c.received === 1 ? <Badge tone="green">Received</Badge> : <Badge tone="neutral">Not received</Badge>}
                </td>
                <td className="right">
                  <Button
                    size="sm"
                    disabled={!canWrite || busy === c.id}
                    loading={busy === c.id}
                    title={canWrite ? undefined : 'You do not have permission to update compliance.'}
                    onClick={() => toggle(c)}
                  >
                    {c.received === 1 ? 'Clear' : 'Mark received'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Won gate tab                                                        */
/* ------------------------------------------------------------------ */

function WonGatePanel({
  data,
  canMarkWon,
  onMarkWon,
}: {
  data: DealBundle;
  canMarkWon: boolean;
  onMarkWon: () => void;
}) {
  const { deal, gate } = data;
  const failed = gate.checks.filter((c) => c.required && !c.passed).length;

  return (
    <Card
      title={gate.ok ? 'Ready to mark Won' : 'Blocked'}
      actions={
        <Button
          size="sm"
          variant={gate.ok ? 'success' : 'default'}
          disabled={!canMarkWon || deal.stage === 'won' || deal.stage === 'lost'}
          title={canMarkWon ? undefined : 'You do not have permission to mark deals Won.'}
          onClick={onMarkWon}
        >
          Mark Won
        </Button>
      }
    >
      <div className="stack">
        {gate.ok ? (
          <div className="success-state">
            All required Won requirements are met — marking Won hands the deal off to Production.
          </div>
        ) : (
          <div className="warn-state">
            {failed} required requirement{failed === 1 ? '' : 's'} outstanding — the server will reject the Won
            handoff until every required check passes.
          </div>
        )}

        <BlockerList items={gate.checks.map((c) => ({ label: c.label, detail: c.detail, passed: c.passed }))} />

        <div className="divider" />
        <div className="small strong">
          Configured requirements for project type “{deal.project_type ? titleCase(deal.project_type) : '—'}”
        </div>
        <KeyValue
          items={GATE_FLAGS.map(
            ([flag, label]) => [label, gate.config?.[flag] ? <Badge tone="blue">Required</Badge> : <Badge tone="outline">Not required</Badge>] as [ReactNode, ReactNode],
          )}
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

function TasksPanel({ data, reload, roster }: { data: DealBundle; reload: () => void; roster: RosterRow[] }) {
  const { deal, tasks } = data;
  const toast = useToast();
  const { can } = useAuth();
  const canWrite = can('task.write');
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const complete = async (task: DealTask) => {
    setBusy(task.id);
    try {
      await post(`/tasks/${task.id}/complete`, {});
      toast.success('Task completed', task.title);
      reload();
    } catch (err) {
      toast.error('Could not complete task', err instanceof ApiError ? err.message : errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Open tasks"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={!canWrite}
          title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
          icon={<Icon name="plus" size={14} />}
          onClick={() => setNewOpen(true)}
        >
          New task
        </Button>
      }
    >
      {tasks.length === 0 ? (
        <EmptyState title="No open tasks" icon={<Icon name="tasks" size={22} />}>
          Create a follow-up to keep this deal moving.
        </EmptyState>
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <li key={t.id} className="list-item">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate">{t.title}</div>
                <div className="tiny muted">
                  {titleCase(t.type)} · {t.assignee_name ?? '—'} · Due {dateShort(t.due_at)}
                  {isOverdue(t.due_at) ? (
                    <span style={{ color: 'var(--red)' }}> · overdue</span>
                  ) : null}
                </div>
              </div>
              <Button size="sm" disabled={!canWrite || busy === t.id} loading={busy === t.id} onClick={() => complete(t)}>
                Complete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {newOpen ? (
        <NewTaskModal
          dealId={deal.id}
          roster={roster}
          onClose={() => setNewOpen(false)}
          onDone={() => {
            setNewOpen(false);
            reload();
          }}
        />
      ) : null}
    </Card>
  );
}

function NewTaskModal({
  dealId,
  roster,
  onClose,
  onDone,
}: {
  dealId: string;
  roster: RosterRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState(roster[0]?.id ?? '');
  const [type, setType] = useState('follow_up');
  const [due, setDue] = useState('');

  const dueMs = dateToMs(due);
  const ready = title.trim().length > 0 && !!assigneeId && dueMs != null;

  const action = useAction(() =>
    post('/tasks', {
      dealId,
      title: title.trim(),
      assigneeId,
      type,
      dueAt: dueMs,
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Task created', title.trim());
      onDone();
    }
  };

  return (
    <Modal
      title="New task"
      sub="Linked to this deal — it shows up in the deal's open tasks."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} disabled={!ready} onClick={submit}>
            Create task
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="form-grid">
          <Select
            label="Assignee"
            required
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            options={roster.map((r) => ({ value: r.id, label: r.name }))}
          />
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={TASK_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
          />
          <Input label="Due" required type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Right rail: deposit                                                 */
/* ------------------------------------------------------------------ */

function DepositCard({ data, reload, canWrite }: { data: DealBundle; reload: () => void; canWrite: boolean }) {
  const { deal, deposit } = data;
  const [editOpen, setEditOpen] = useState(false);

  return (
    <Card
      title="Deposit"
      actions={
        <Button
          size="sm"
          disabled={!canWrite}
          title={canWrite ? undefined : 'You do not have permission to edit the deposit.'}
          onClick={() => setEditOpen(true)}
        >
          Edit
        </Button>
      }
    >
      {deposit ? (
        <KeyValue
          items={[
            ['Amount', money2(deposit.amount)],
            ['Status', titleCase(deposit.status)],
            ['Due', dateShort(deposit.due_at)],
            ['Method', deposit.method || '—'],
            ['Reference', deposit.reference || '—'],
          ]}
        />
      ) : (
        <div className="muted small">No deposit recorded yet.</div>
      )}

      {editOpen ? (
        <DepositModal
          dealId={deal.id}
          deposit={deposit}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false);
            reload();
          }}
        />
      ) : null}
    </Card>
  );
}

function DepositModal({
  dealId,
  deposit,
  onClose,
  onDone,
}: {
  dealId: string;
  deposit: Deposit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(deposit?.amount != null ? String(deposit.amount) : '');
  const [status, setStatus] = useState(deposit?.status ?? 'due');
  const [due, setDue] = useState(deposit?.due_at ? new Date(deposit.due_at).toISOString().slice(0, 10) : '');

  const action = useAction(() =>
    put(`/deals/${dealId}/deposit`, {
      amount: Number(amount) || 0,
      status,
      dueAt: dateToMs(due),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Deposit updated', `${titleCase(status)} — ${money2(Number(amount) || 0)}.`);
      onDone();
    }
  };

  return (
    <Modal
      title="Deposit"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={action.pending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <div className="form-grid">
          <Input
            label="Amount"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={DEPOSIT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))}
          />
          <Input label="Due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Re-pricing                                                          */
/* ------------------------------------------------------------------ */

function RepricingModal({
  dealId,
  dealNo,
  onClose,
  onDone,
}: {
  dealId: string;
  dealNo: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');

  const action = useAction(() => post(`/deals/${dealId}/request-repricing`, { reason: reason.trim() }));

  const submit = async () => {
    if (reason.trim().length < 5) return;
    const res = await action.run();
    if (res) {
      toast.success('Re-pricing requested', res.note ?? 'The quote is back with Underwriting.');
      onDone();
    }
  };

  return (
    <Modal
      title={`Request re-pricing — ${dealNo}`}
      sub="Closers cannot edit price. This sends the quote back to Underwriting and it can no longer be presented to the customer."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={action.pending}
            disabled={reason.trim().length < 5}
            onClick={submit}
          >
            Send back to Underwriting
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <TextArea
          label="Reason"
          required
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Material costs moved since the takeoff — the margin no longer holds."
          hint={`${reason.trim().length} / 5 characters minimum — why must the price change?`}
        />
      </div>
    </Modal>
  );
}
