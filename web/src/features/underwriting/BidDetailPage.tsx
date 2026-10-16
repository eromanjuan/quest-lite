import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { del, get, patch, post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
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
  Field,
  FormActions,
  Input,
  KeyValue,
  LinkButton,
  Loading,
  Meter,
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
  dateTime,
  daysSince,
  fromLocalInputValue,
  money2,
  num,
  pct,
  pctRaw,
  stageLabel,
  TEMPERATURE_LABELS,
  titleCase,
  toLocalInputValue,
  TRADE_LABELS,
} from '../../lib/format';

/* ------------------------------------------------------------------ */
/* Constants and types                                                 */
/* ------------------------------------------------------------------ */

const STAGES = ['scope', 'takeoff', 'uw_sheet', 'quote_built'];

const PANELS = ['scope', 'takeoff', 'sheet', 'subquotes', 'estimate', 'plans'];

const HIDDEN = { display: 'none' } as const;

const STAGE_TONE: Record<string, Tone> = {
  scope: 'neutral',
  takeoff: 'blue',
  uw_sheet: 'violet',
  quote_built: 'green',
};

interface ScopeQuestion {
  id: string;
  label: string;
  type: string;
  options?: string[];
  unit?: string;
  required?: boolean;
  help?: string;
}

interface ScopeTemplate {
  id?: string;
  trade?: string;
  name?: string;
  version?: number;
  questions: ScopeQuestion[];
}

interface BidDetail {
  bid: any;
  scopeResponses: any[];
  scopeTemplate: ScopeTemplate | null;
  planRevisions: any[];
  takeoffItems: any[];
  subQuotes: any[];
  estimates: any[];
  documents: any[];
  marginApprovals: any[];
  missing?: string[];
}

interface MarginCheck {
  ok: boolean;
  metric: 'gross' | 'net';
  actual: number | null;
  floor: number;
  below: boolean;
}

interface PreviewResult {
  calc: any;
  floor: number;
  margin: MarginCheck;
  benchmarkFlags: any[];
  trade?: string;
}

interface ReleaseCheck {
  ok: boolean;
  blockers: Array<{ key?: string; label: string; detail?: string }>;
  calc: any;
  marginFloor: number;
  bidId?: string;
  bidNo?: string;
  requiresApprovalRole?: boolean;
}

interface SheetLine {
  id?: string;
  code?: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  categoryKey?: string | null;
  categoryId?: string | null;
  taxable: boolean;
}

interface SheetInputs {
  sheet: 'roofing' | 'crew' | 'generic';
  taxRate: number;
  commissionPct: number;
  otherExpenses: number;
  sellLines: SheetLine[];
  costLines: SheetLine[];
  areaSqft?: number;
  scopeText: string;
  exclusionsText: string;
  options: any[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stageTone(stage: unknown): Tone {
  return STAGE_TONE[String(stage)] ?? 'neutral';
}

function tempTone(temp: unknown): Tone {
  const t = String(temp);
  return t === 'hot' ? 'red' : t === 'cold' ? 'blue' : 'amber';
}

function estimateTone(status: unknown): Tone {
  const s = String(status);
  if (s === 'released') return 'green';
  if (s === 'draft') return 'blue';
  if (s === 'pending_release') return 'amber';
  if (s === 'superseded') return 'neutral';
  return 'outline';
}

function approvalTone(status: unknown): Tone {
  const s = String(status);
  if (s === 'approved') return 'green';
  if (s === 'rejected') return 'red';
  if (s === 'pending') return 'amber';
  return 'neutral';
}

function subQuoteTone(status: unknown): Tone {
  const s = String(status);
  if (s === 'accepted') return 'green';
  if (s === 'received') return 'blue';
  if (s === 'declined') return 'red';
  if (s === 'expired') return 'outline';
  return 'neutral';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

function parseAnswers(raw: unknown): Record<string, any> {
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, any>) } : {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') return { ...(raw as Record<string, any>) };
  return {};
}

function scopeProgress(questions: ScopeQuestion[], answers: Record<string, any>) {
  const required = questions.filter((q) => q.required);
  const answered = required.filter((q) => !isEmptyValue(answers[q.id]));
  const pctValue = required.length ? (answered.length / required.length) * 100 : 100;
  return { required: required.length, answered: answered.length, pct: pctValue };
}

/** `<input type="date">` wants YYYY-MM-DD; the API wants epoch ms. */
function dateInput(v: unknown): string {
  return toLocalInputValue(v as number | string | null | undefined).slice(0, 10);
}

/** YYYY-MM-DD would be read as UTC midnight by Date() — pin it to local midnight. */
function dateToMs(v: string): number | null {
  return v ? fromLocalInputValue(`${v}T00:00`) : null;
}

/** Mirrors marginFloorFor() in server/routes/estimates.ts (trade override first). */
function marginFloorFor(cfg: any, trade: unknown): number | null {
  const floor = cfg?.settings?.margin_floor;
  if (!floor) return null;
  const key = String(trade ?? '');
  if (key && typeof floor.by_trade?.[key] === 'number') return floor.by_trade[key];
  return typeof floor.default === 'number' ? floor.default : null;
}

/** The release gate reads net margin first, gross second — same rule here. */
function belowFloor(calc: any, floorPct: number | null): boolean {
  if (!calc || floorPct === null || floorPct <= 0) return false;
  const margin = typeof calc.netMargin === 'number' ? calc.netMargin : calc.grossMargin;
  return typeof margin === 'number' && margin * 100 < floorPct;
}

/** Defaults mirror the API's inputsSchema so a fresh sheet matches the server. */
function defaultSheetInputs(): SheetInputs {
  return {
    sheet: 'generic',
    taxRate: 8.5,
    commissionPct: 10,
    otherExpenses: 0,
    sellLines: [],
    costLines: [],
    scopeText: '',
    exclusionsText: '',
    options: [],
  };
}

function toLine(raw: any): SheetLine {
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    id: raw?.id ?? undefined,
    code: raw?.code ?? undefined,
    description: typeof raw?.description === 'string' ? raw.description : '',
    qty: n(raw?.qty),
    unit: typeof raw?.unit === 'string' && raw.unit ? raw.unit : 'ea',
    unitPrice: n(raw?.unitPrice),
    categoryKey: raw?.categoryKey ?? undefined,
    categoryId: raw?.categoryId ?? undefined,
    taxable: !!raw?.taxable,
  };
}

function toSheetInputs(raw: any): SheetInputs {
  const d = defaultSheetInputs();
  if (!raw || typeof raw !== 'object') return d;
  const n = (v: any, fb: number) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  return {
    sheet: raw.sheet === 'roofing' || raw.sheet === 'crew' || raw.sheet === 'generic' ? raw.sheet : d.sheet,
    taxRate: n(raw.taxRate, d.taxRate),
    commissionPct: n(raw.commissionPct, d.commissionPct),
    otherExpenses: n(raw.otherExpenses, d.otherExpenses),
    sellLines: Array.isArray(raw.sellLines) ? raw.sellLines.map(toLine) : [],
    costLines: Array.isArray(raw.costLines) ? raw.costLines.map(toLine) : [],
    areaSqft:
      raw.areaSqft === undefined || raw.areaSqft === null || raw.areaSqft === ''
        ? undefined
        : n(raw.areaSqft, 0),
    scopeText: typeof raw.scopeText === 'string' ? raw.scopeText : '',
    exclusionsText: typeof raw.exclusionsText === 'string' ? raw.exclusionsText : '',
    options: Array.isArray(raw.options) ? raw.options : [],
  };
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */

export default function BidDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState('scope');
  const [editOpen, setEditOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  const bidRes = useFetch<BidDetail>(id ? `/bids/${id}` : null, [id]);
  const configRes = useFetch<any>('/config', []);
  const estRes = useFetch<{ bid: any; estimates: any[] }>(id ? `/estimates/bid/${id}` : null, [id]);

  const bid = bidRes.data?.bid ?? null;
  const trade: string = bid ? String(bid.trade ?? '') : '';
  const tplRes = useFetch<ScopeTemplate>(bid ? `/config/scope-template/${trade}` : null, [trade]);

  const estimates = estRes.data?.estimates ?? bidRes.data?.estimates ?? [];
  const activeEstimate = estimates.find((e: any) => e.status === 'draft') ?? estimates[0] ?? null;
  const activeId: string | null = activeEstimate?.id ?? null;
  const detailRes = useFetch<any>(activeId ? `/estimates/${activeId}` : null, [activeId]);

  /** Bid-level approvals, with decider names when the estimate detail has them. */
  const approvals = useMemo(() => {
    const list = bidRes.data?.marginApprovals ?? [];
    const detailed = detailRes.data?.approvals ?? [];
    const byId = new Map<string, any>(detailed.map((a: any) => [a.id, a]));
    return list.map((a: any) => byId.get(a.id) ?? a);
  }, [bidRes.data, detailRes.data]);

  const reloadAll = () => {
    bidRes.reload();
    estRes.reload();
    detailRes.reload();
  };

  if (bidRes.loading && !bidRes.data) return <Loading label="Loading bid…" />;
  if (!bidRes.data || !bid) {
    return (
      <div className="stack">
        <LinkButton to="/underwriting" size="sm">
          ← Back to bid queue
        </LinkButton>
        <ErrorState error={bidRes.error ?? new Error('Bid not found.')} onRetry={bidRes.reload} />
      </div>
    );
  }

  const template: ScopeTemplate | null = tplRes.data ?? bidRes.data.scopeTemplate ?? null;
  const config = configRes.data;
  const revisions = bidRes.data.planRevisions ?? [];
  const takeoffItems = bidRes.data.takeoffItems ?? [];
  const subQuotes = bidRes.data.subQuotes ?? [];
  const missing: string[] = bidRes.data.missing ?? [];
  const costCategories = config?.costCategories ?? [];
  const bidDispositions = (config?.dispositions ?? []).filter((d: any) => d.workspace === 'bid');

  const canWriteBid = can('bid.write');
  const canWriteEstimate = can('estimate.write');

  const stageIdx = STAGES.indexOf(String(bid.stage));
  const nextStage = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;

  const advanceStage = async () => {
    if (!nextStage) return;
    setAdvancing(true);
    try {
      await patch(`/bids/${id}`, { stage: nextStage });
      toast.success('Stage advanced', `${bid.bid_no} moved to ${stageLabel(nextStage)}.`);
      reloadAll();
    } catch (e) {
      // The server refuses moves of more than one step — its message explains why.
      toast.error('Could not advance the stage', errMsg(e));
    } finally {
      setAdvancing(false);
    }
  };

  const tabs = [
    { key: 'scope', label: 'Scope' },
    { key: 'takeoff', label: 'Takeoff', count: takeoffItems.length },
    { key: 'sheet', label: 'Sheet' },
    { key: 'subquotes', label: 'Sub quotes', count: subQuotes.length },
    { key: 'estimate', label: 'Estimate', count: estimates.length },
    { key: 'plans', label: 'Plans', count: revisions.length },
  ];

  const renderPanel = (key: string) => {
    switch (key) {
      case 'scope':
        return (
          <ScopeTab
            bidId={id}
            template={template}
            templateLoading={tplRes.loading && !template}
            initialAnswers={bidRes.data?.scopeResponses?.[0]?.answers}
            canWrite={canWriteBid}
            onChanged={reloadAll}
          />
        );
      case 'takeoff':
        return (
          <TakeoffTab
            bidId={id}
            revisions={revisions}
            items={takeoffItems}
            canWrite={canWriteBid}
            onChanged={reloadAll}
            onAddRevision={() => setPlanOpen(true)}
          />
        );
      case 'sheet':
        return (
          <SheetTab
            bidId={id}
            activeEstimate={activeEstimate}
            approvals={approvals}
            canWrite={canWriteEstimate}
            canRequest={can('margin.request_exception')}
            canApprove={can('margin.approve_exception')}
            categories={costCategories}
            active={tab === 'sheet'}
            onChanged={reloadAll}
          />
        );
      case 'subquotes':
        return (
          <SubQuotesTab
            bidId={id}
            rows={subQuotes}
            canWrite={canWriteBid}
            onChanged={reloadAll}
          />
        );
      case 'estimate':
        return (
          <EstimateTab
            bidNo={String(bid.bid_no ?? '')}
            estimates={estimates}
            approvals={approvals}
            canRelease={can('estimate.release')}
            onChanged={reloadAll}
          />
        );
      case 'plans':
        return <PlansTab revisions={revisions} canWrite={canWriteBid} onAdd={() => setPlanOpen(true)} />;
      default:
        return null;
    }
  };

  const savedAnswers = parseAnswers(bidRes.data.scopeResponses?.[0]?.answers);
  const progress = template ? scopeProgress(template.questions ?? [], savedAnswers) : null;
  const floorPct = marginFloorFor(config, trade);
  const estCalc = activeEstimate?.calc ?? null;

  return (
    <div className="stack">
      <PageHead
        title={<span className="mono">{String(bid.bid_no ?? 'Bid')}</span>}
        sub={
          bid.project_address ||
          bid.scope_summary ||
          'No project address yet.'
        }
        actions={
          <div className="row wrap">
            <LinkButton to="/underwriting" size="sm">
              ← Bid queue
            </LinkButton>
            {canWriteBid ? (
              <Button size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            ) : null}
            {nextStage && canWriteBid ? (
              <Button size="sm" variant="primary" loading={advancing} onClick={advanceStage}>
                Advance to {stageLabel(nextStage)}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="row wrap">
          <Badge tone="blue">{TRADE_LABELS[trade] ?? titleCase(trade)}</Badge>
          <Badge tone={stageTone(bid.stage)}>{stageLabel(String(bid.stage ?? ''))}</Badge>
          {bid.disposition_name ? <Badge tone="outline">{bid.disposition_name}</Badge> : null}
          <Badge tone={tempTone(bid.temperature)} dot>
            {TEMPERATURE_LABELS[String(bid.temperature)] ?? titleCase(String(bid.temperature ?? ''))}
          </Badge>
          {bid.takeoff_required === 1 ? <Badge tone="amber">Takeoff required</Badge> : null}
          <Badge tone="neutral">{titleCase(String(bid.perform_mode ?? 'self'))} delivery</Badge>
        </div>
      </PageHead>

      <div className="split-wide">
        <div className="stack">
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          {/*
            Every panel stays mounted (hidden) so unsaved work — scope answers,
            a half-typed sheet — survives a tab switch.
          */}
          <div className="stack">
            {PANELS.map((key) => (
              <div key={key} style={tab === key ? undefined : HIDDEN}>
                {renderPanel(key)}
              </div>
            ))}
          </div>
        </div>

        <aside className="stack">
          <Card title="Bid summary">
            <KeyValue
              items={[
                ['Address', bid.project_address || '—'],
                ['Contact', bid.contact_name || '—'],
                ['Company', bid.company_name || '—'],
                ['Estimator', bid.estimator_name || 'Unassigned'],
                ['Started', dateShort(bid.started_at)],
                ['Age', daysSince(bid.started_at) !== null ? `${daysSince(bid.started_at)}d` : '—'],
                [
                  'Due',
                  bid.quote_due_at ? (
                    <span>
                      {dateShort(bid.quote_due_at)}
                      {Number(bid.quote_due_at) < Date.now() ? (
                        <span className="tiny" style={{ color: 'var(--red)' }}>
                          {' '}
                          overdue
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    '—'
                  ),
                ],
                ['Missing info', missing.length ? `${missing.length} item(s)` : 'None'],
              ]}
            />
            {missing.length ? (
              <div className="stack" style={{ gap: 4, marginTop: 10 }}>
                <div className="tiny muted strong">OUTSTANDING</div>
                {missing.map((m) => (
                  <div key={m} className="tiny">
                    {m}
                  </div>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title="Scope completeness" sub="From the last saved scope intake">
            {tplRes.loading && !template ? (
              <Loading label="Loading template…" />
            ) : progress ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <span className="grow small strong">
                    {progress.answered} of {progress.required} required answered
                  </span>
                  <span className="small muted">
                    {progress.required ? pctRaw(progress.pct, 0) : 'No required questions'}
                  </span>
                </div>
                <Meter value={progress.pct} tone={progress.pct >= 100 ? 'good' : 'warn'} />
              </div>
            ) : (
              <div className="small muted">—</div>
            )}
            <div style={{ marginTop: 10 }}>
              {missing.length ? (
                <BlockerList items={missing.map((m) => ({ label: m }))} />
              ) : (
                <div className="small">Nothing outstanding on the saved answers.</div>
              )}
            </div>
          </Card>

          <Card title="Margin floor" sub="Configured in admin settings for this trade">
            <KeyValue
              items={[
                ['Floor', floorPct !== null ? pctRaw(floorPct) : '—'],
                ['Estimate', activeEstimate ? `v${activeEstimate.version}` : '—'],
                ['Gross margin', pct(estCalc?.grossMargin)],
                ['Net margin', pct(estCalc?.netMargin)],
              ]}
            />
            {activeEstimate && belowFloor(estCalc, floorPct) ? (
              <div className="warn-state small" style={{ marginTop: 10 }}>
                The current estimate prices below the {floorPct}% floor — release needs an approved
                exception.
              </div>
            ) : null}
          </Card>
        </aside>
      </div>

      {editOpen ? (
        <EditBidModal
          bid={bid}
          dispositions={bidDispositions}
          onClose={() => setEditOpen(false)}
          onSaved={(row) => {
            setEditOpen(false);
            toast.success('Bid updated', `${row?.bid_no ?? bid.bid_no} saved.`);
            reloadAll();
          }}
        />
      ) : null}

      {planOpen ? (
        <PlanModal
          bidId={id}
          onClose={() => setPlanOpen(false)}
          onSaved={(row) => {
            setPlanOpen(false);
            toast.success('Plan revision added', `Revision ${row?.revision_no ?? ''} is now current.`);
            reloadAll();
          }}
        />
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Scope tab                                                           */
/* ================================================================== */

function ScopeTab({
  bidId,
  template,
  templateLoading,
  initialAnswers,
  canWrite,
  onChanged,
}: {
  bidId: string;
  template: ScopeTemplate | null;
  templateLoading: boolean;
  initialAnswers: unknown;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [answers, setAnswers] = useState<Record<string, any>>(() => parseAnswers(initialAnswers));
  const [saved, setSaved] = useState<{ missing: string[]; complete: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const seeded = useRef(false);

  // Seed once the template (and therefore the saved response) is available.
  useEffect(() => {
    if (seeded.current || !template) return;
    seeded.current = true;
    setAnswers(parseAnswers(initialAnswers));
  }, [template, initialAnswers]);

  if (templateLoading) {
    return <Loading label="Loading scope template…" />;
  }
  if (!template) {
    return (
      <EmptyState title="No scope template for this trade" icon={<span>📋</span>}>
        An administrator must add an active scope template before intake can run for this trade.
      </EmptyState>
    );
  }

  const questions = template.questions ?? [];
  const progress = scopeProgress(questions, answers);
  const setAnswer = (qid: string, value: any) => setAnswers((a) => ({ ...a, [qid]: value }));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Only keys the active template knows — a stale answer would 422.
      const payload: Record<string, any> = {};
      for (const q of questions) {
        if (Object.prototype.hasOwnProperty.call(answers, q.id)) payload[q.id] = answers[q.id];
      }
      const res = await post<{ missing?: string[]; complete?: boolean }>(`/bids/${bidId}/scope`, {
        answers: payload,
      });
      const list = res.missing ?? [];
      setSaved({ missing: list, complete: !!res.complete });
      toast.success(
        'Scope saved',
        res.complete ? 'Every required question is answered.' : `${list.length} required answer(s) still missing.`,
      );
      onChanged();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setSaving(false);
    }
  };

  const hintFor = (q: ScopeQuestion) =>
    [q.help, q.unit ? `Unit: ${q.unit}` : ''].filter(Boolean).join(' · ') || undefined;

  const control = (q: ScopeQuestion) => {
    const v = answers[q.id];
    const disabled = !canWrite;
    const text = v === undefined || v === null ? '' : String(v);
    switch (q.type) {
      case 'select':
        return (
          <Select
            aria-label={q.label}
            value={typeof v === 'string' ? v : ''}
            disabled={disabled}
            placeholder="Select…"
            options={(q.options ?? []).map((o) => ({ value: o, label: o }))}
            onChange={(e) => setAnswer(q.id, e.target.value)}
          />
        );
      case 'number':
        return (
          <Input
            aria-label={q.label}
            type="number"
            value={text}
            disabled={disabled}
            onChange={(e) => setAnswer(q.id, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'textarea':
        return (
          <TextArea
            aria-label={q.label}
            rows={3}
            value={text}
            disabled={disabled}
            onChange={(e) => setAnswer(q.id, e.target.value)}
          />
        );
      case 'yesno':
        return (
          <Segmented<string>
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            value={v === true ? 'yes' : v === false ? 'no' : ''}
            onChange={(nv) => setAnswer(q.id, nv === 'yes')}
          />
        );
      case 'text':
      default:
        return (
          <Input
            aria-label={q.label}
            value={text}
            disabled={disabled}
            onChange={(e) => setAnswer(q.id, e.target.value)}
          />
        );
    }
  };

  return (
    <Card
      title="Scope intake"
      sub={template.name ? `${template.name} · v${template.version ?? 1}` : 'Active template for this trade'}
    >
      <div className="stack">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <span className="grow small strong">
              {progress.answered} / {progress.required} required answered
            </span>
            <span className="small muted">
              {progress.required ? pctRaw(progress.pct, 0) : 'All questions are optional'}
            </span>
          </div>
          <Meter value={progress.pct} tone={progress.pct >= 100 ? 'good' : 'warn'} />
        </div>

        {saved ? (
          saved.complete ? (
            <div className="success-state">Saved — every required scope question is answered.</div>
          ) : (
            <div className="warn-state">
              Saved, but still missing: {saved.missing.join(', ') || 'required answers'}.
            </div>
          )
        ) : null}

        {err ? <ErrorState error={err} /> : null}

        {questions.length === 0 ? (
          <EmptyState title="This template has no questions" icon={<span>—</span>} />
        ) : (
          questions.map((q) => (
            <Field key={q.id} label={q.label} required={q.required} hint={hintFor(q)}>
              {control(q)}
            </Field>
          ))
        )}

        <div
          className="row wrap"
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 1,
            background: 'var(--surface-2)',
            borderTop: '1px solid var(--line)',
            padding: '10px 0',
          }}
        >
          <span className="grow small muted">
            {canWrite
              ? 'Answers are stored against the active scope template for this trade.'
              : 'Editing scope intake requires the bid.write permission.'}
          </span>
          <Button variant="primary" onClick={save} loading={saving} disabled={!canWrite}>
            Save scope
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ================================================================== */
/* Takeoff tab                                                         */
/* ================================================================== */

function TakeoffTab({
  bidId,
  revisions,
  items,
  canWrite,
  onChanged,
  onAddRevision,
}: {
  bidId: string;
  revisions: any[];
  items: any[];
  canWrite: boolean;
  onChanged: () => void;
  onAddRevision: () => void;
}) {
  const toast = useToast();
  const [revFilter, setRevFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!revisions.length) {
    return (
      <EmptyState
        title="No plan revisions yet"
        icon={<span>📐</span>}
        action={
          canWrite ? (
            <Button variant="primary" onClick={onAddRevision}>
              Add plan revision
            </Button>
          ) : null
        }
      >
        Takeoff quantities must be tied to a plan revision — add the first revision to start
        measuring.
      </EmptyState>
    );
  }

  const current = revisions.find((r) => r.is_current === 1) ?? revisions[0];
  const visible = items.filter((i) => !revFilter || i.plan_revision_id === revFilter);

  const commitQty = async (item: any, qty: number) => {
    try {
      await patch(`/bids/takeoff/${item.id}`, { qty });
      onChanged();
    } catch (e) {
      toast.error('Could not update the quantity', errMsg(e));
      onChanged();
    }
  };

  const commitStatus = async (item: any, reviewStatus: string) => {
    // The API field is review_status — a camelCase key would be dropped.
    try {
      await patch(`/bids/takeoff/${item.id}`, { review_status: reviewStatus });
      onChanged();
    } catch (e) {
      toast.error('Could not update the review status', errMsg(e));
      onChanged();
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await del(`/bids/takeoff/${toDelete.id}`);
      toast.success('Takeoff item removed', `${toDelete.code} deleted.`);
      setToDelete(null);
      onChanged();
    } catch (e) {
      toast.error('Could not remove the takeoff item', errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="stack">
      <div className="row wrap">
        <span className="tiny muted strong">PLAN REVISION</span>
        <Select
          aria-label="Filter by plan revision"
          value={revFilter}
          onChange={(e) => setRevFilter(e.target.value)}
          options={[
            { value: '', label: 'All revisions' },
            ...revisions.map((r) => ({
              value: r.id,
              label: `R${r.revision_no} · ${r.label || 'Untitled'}${r.is_current ? ' (current)' : ''}`,
            })),
          ]}
        />
        <span className="small muted">
          Items are added to R{current?.revision_no} (current).
        </span>
        <span className="spacer" />
        {canWrite ? (
          <Button size="sm" onClick={() => setAddOpen(true)} icon={<Icon name="plus" size={14} />}>
            Add item
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No takeoff items yet" icon={<span>📏</span>}>
          {revFilter
            ? 'This revision has no quantities recorded.'
            : 'Add the first measured quantity against the current plan revision.'}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th>
                <th>Description</th>
                <th className="num">Qty</th>
                <th>Unit</th>
                <th>Review status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td className="mono strong nowrap">{item.code}</td>
                  <td>{item.description || <span className="muted">—</span>}</td>
                  <td className="num" style={{ width: 110 }}>
                    {canWrite ? (
                      <NumCell
                        value={Number(item.qty)}
                        ariaLabel={`Quantity for ${item.code}`}
                        onCommit={(n) => commitQty(item, n)}
                      />
                    ) : (
                      num(Number(item.qty), 2)
                    )}
                  </td>
                  <td className="nowrap">{item.unit || '—'}</td>
                  <td>
                    {canWrite ? (
                      <Select
                        aria-label={`Review status for ${item.code}`}
                        value={String(item.review_status ?? 'draft')}
                        onChange={(e) => commitStatus(item, e.target.value)}
                        options={[
                          { value: 'draft', label: 'Draft' },
                          { value: 'reviewed', label: 'Reviewed' },
                          { value: 'disputed', label: 'Disputed' },
                        ]}
                      />
                    ) : (
                      <Badge tone={item.review_status === 'reviewed' ? 'green' : item.review_status === 'disputed' ? 'red' : 'neutral'}>
                        {titleCase(String(item.review_status ?? 'draft'))}
                      </Badge>
                    )}
                  </td>
                  <td className="right">
                    {canWrite ? (
                      <Button size="sm" variant="ghost" onClick={() => setToDelete(item)} aria-label={`Delete ${item.code}`}>
                        ✕
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="small muted">
        Quantities can only be tied to the current plan revision — the server rejects any item
        added against an older one.
      </p>

      {addOpen ? (
        <AddTakeoffModal
          bidId={bidId}
          revisions={revisions}
          onClose={() => setAddOpen(false)}
          onSaved={(row) => {
            setAddOpen(false);
            toast.success('Takeoff item added', `${row?.code ?? ''} recorded.`);
            onChanged();
          }}
        />
      ) : null}

      {toDelete ? (
        <ConfirmDialog
          title="Remove takeoff item"
          message={
            <>
              Remove <strong className="mono">{toDelete.code}</strong> from this bid&apos;s takeoff?
              The quantity cannot be recovered.
            </>
          }
          confirmLabel="Remove item"
          loading={deleting}
          onConfirm={remove}
          onCancel={() => setToDelete(null)}
        />
      ) : null}
    </div>
  );
}

function AddTakeoffModal({
  bidId,
  revisions,
  onClose,
  onSaved,
}: {
  bidId: string;
  revisions: any[];
  onClose: () => void;
  onSaved: (row: any) => void;
}) {
  const current = revisions.find((r) => r.is_current === 1) ?? revisions[0];
  const [planRevisionId, setPlanRevisionId] = useState(String(current?.id ?? ''));
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('sq');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const valid =
    !!planRevisionId && code.trim().length > 0 && qty !== '' && Number.isFinite(Number(qty)) && Number(qty) >= 0;

  const submit = async () => {
    if (!valid) return;
    setPending(true);
    setErr(null);
    try {
      const row = await post<{ row: any }>(`/bids/${bidId}/takeoff`, {
        planRevisionId,
        code: code.trim(),
        description,
        qty: Number(qty),
        unit: unit.trim() || 'sq',
      });
      onSaved(row.row);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Add takeoff item"
      sub="Measured against a plan revision."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!valid}>
            Add item
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {/* 409: the chosen revision is no longer the current one. */}
        {err ? <ErrorState error={err} /> : null}
        <div className="form-grid">
          <Select
            label="Plan revision"
            required
            value={planRevisionId}
            onChange={(e) => setPlanRevisionId(e.target.value)}
            error={err?.fieldErrors?.planRevisionId}
            options={revisions.map((r) => ({
              value: r.id,
              label: `R${r.revision_no} · ${r.label || 'Untitled'}${r.is_current ? ' (current)' : ''}`,
            }))}
          />
          <Input
            label="Code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. TPO-60"
            error={err?.fieldErrors?.code}
          />
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={err?.fieldErrors?.description}
          />
          <Input
            label="Quantity"
            required
            type="number"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            error={err?.fieldErrors?.qty}
          />
          <Input
            label="Unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            hint="sq, lf, ea…"
            error={err?.fieldErrors?.unit}
          />
        </div>
        <Callout tone="grey">
          Items must be added against the current revision — the server returns a conflict if an
          older revision is selected.
        </Callout>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Sheet tab — the underwriting calculator                             */
/* ================================================================== */

function SheetTab({
  bidId,
  activeEstimate,
  approvals,
  canWrite,
  canRequest,
  canApprove,
  categories,
  active,
  onChanged,
}: {
  bidId: string;
  activeEstimate: any | null;
  approvals: any[];
  canWrite: boolean;
  canRequest: boolean;
  canApprove: boolean;
  categories: any[];
  active: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const activeId: string | null = activeEstimate?.id ?? null;
  const isReleased = activeEstimate?.status === 'released';

  const [inputs, setInputs] = useState<SheetInputs>(() => toSheetInputs(activeEstimate?.inputs));
  const seededFor = useRef<string | null | undefined>(undefined);
  const [newVersion, setNewVersion] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<ApiError | null>(null);

  const [exceptionOpen, setExceptionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<ApiError | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const [target, setTarget] = useState<{
    metric: 'gross' | 'net';
    targetMarginPct: string;
    hardCost: string;
    commissionPct: string;
    otherExpenses: string;
  }>(() => ({
    metric: 'gross',
    targetMarginPct: '',
    hardCost: '',
    commissionPct: String(inputs.commissionPct),
    otherExpenses: String(inputs.otherExpenses),
  }));
  const [targetResult, setTargetResult] = useState<any>(null);
  const [targetErr, setTargetErr] = useState<ApiError | null>(null);
  const [targetPending, setTargetPending] = useState(false);
  const [hardCostTouched, setHardCostTouched] = useState(false);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Load the persisted inputs whenever the active estimate changes identity.
  useEffect(() => {
    if (seededFor.current === activeId) return;
    seededFor.current = activeId;
    setInputs(toSheetInputs(activeEstimate?.inputs));
  }, [activeId, activeEstimate]);

  useEffect(() => {
    setNewVersion(false);
  }, [activeId]);

  const previewKey = JSON.stringify(inputs);
  const debouncedKey = useDebounced(previewKey, 350);

  // Live recalculation: POST /estimates/preview never persists anything.
  useEffect(() => {
    if (!active || !canWrite) return;
    let cancelled = false;
    setPreviewing(true);
    post<PreviewResult>('/estimates/preview', { bidId, inputs: JSON.parse(debouncedKey) })
      .then((res) => {
        if (!cancelled) {
          setPreview(res);
          setPreviewError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedKey, active, canWrite, bidId]);

  useEffect(() => {
    if (!hardCostTouched && typeof preview?.calc?.hardCost === 'number') {
      setTarget((t) => ({ ...t, hardCost: String(preview.calc.hardCost) }));
    }
  }, [preview?.calc?.hardCost, hardCostTouched]);

  const editable = canWrite && (!isReleased || newVersion);
  const calc: any = canWrite ? (preview ? preview.calc : null) : (activeEstimate?.calc ?? null);
  const margin: MarginCheck | null = canWrite ? preview?.margin ?? null : null;
  const benchmarkFlags: any[] = (canWrite ? preview?.benchmarkFlags : null) ?? [];
  const categoryOptions = categories.map((c: any) => ({ value: String(c.key), label: String(c.name) }));

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      if (!activeId || newVersion) {
        await post(`/estimates/bid/${bidId}`, {
          ...inputs,
          title: activeEstimate?.title ?? '',
          parentEstimateId: activeId ?? undefined,
        });
        toast.success(
          'Estimate saved',
          activeId ? `New version created from v${activeEstimate?.version ?? ''}.` : 'First estimate version created.',
        );
      } else {
        await patch(`/estimates/${activeId}`, { inputs });
        toast.success('Estimate saved', 'Recomputed on the server.');
      }
      setNewVersion(false);
      setSaveErr(null);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      setSaveErr(err);
      if (err.status === 409) {
        // Released quotes are immutable — offer a new version instead of an edit.
        setNewVersion(true);
        toast.error('Released quote', err.message);
      } else {
        toast.error('Could not save the estimate', err.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const addSellLine = () =>
    setInputs((s) => ({
      ...s,
      sellLines: [
        ...s.sellLines,
        { id: crypto.randomUUID(), description: '', qty: 1, unit: 'ea', unitPrice: 0, taxable: false },
      ],
    }));

  const addCostLine = () =>
    setInputs((s) => ({
      ...s,
      costLines: [
        ...s.costLines,
        {
          id: crypto.randomUUID(),
          description: '',
          qty: 1,
          unit: 'ea',
          unitPrice: 0,
          categoryKey: 'labor',
          taxable: false,
        },
      ],
    }));

  const runTargetPrice = async () => {
    setTargetPending(true);
    setTargetErr(null);
    setTargetResult(null);
    try {
      const res = await post('/estimates/target-price', {
        metric: target.metric,
        targetMarginPct: Number(target.targetMarginPct),
        hardCost: target.hardCost === '' ? 0 : Number(target.hardCost),
        commissionPct: target.commissionPct === '' ? 0 : Number(target.commissionPct),
        otherExpenses: target.otherExpenses === '' ? 0 : Number(target.otherExpenses),
      });
      setTargetResult(res);
    } catch (e) {
      setTargetErr(e as ApiError);
    } finally {
      setTargetPending(false);
    }
  };

  const submitException = async () => {
    if (!activeId) return;
    setRequesting(true);
    setReasonErr(null);
    try {
      await post(`/estimates/${activeId}/request-exception`, { reason: reason.trim() });
      toast.success('Exception requested', 'An approver has been notified.');
      setExceptionOpen(false);
      setReason('');
      onChanged();
    } catch (e) {
      // 400 (not below floor) and 409 (already pending) both land here.
      setReasonErr(e as ApiError);
    } finally {
      setRequesting(false);
    }
  };

  const decide = async (approval: any, decision: 'approved' | 'rejected') => {
    setDeciding(approval.id);
    try {
      await post(`/estimates/margin-approvals/${approval.id}/decide`, { decision });
      toast.success(`Exception ${decision}`, `Requested margin ${pctRaw(approval.requested_margin)}.`);
      onChanged();
    } catch (e) {
      toast.error('Could not record the decision', errMsg(e));
    } finally {
      setDeciding(null);
    }
  };

  const scopeShort = inputs.scopeText.trim().length < 20;
  const exclShort = inputs.exclusionsText.trim().length < 5;

  return (
    <div className="stack">
      <Card
        title="Underwriting sheet"
        sub={
          activeEstimate
            ? `Estimate v${activeEstimate.version} · ${titleCase(String(activeEstimate.status ?? ''))}`
            : 'No estimate saved yet'
        }
        actions={
          editable ? (
            <div className="row wrap">
              {previewing ? <span className="tiny muted">Recalculating…</span> : null}
              <Button variant="primary" onClick={save} loading={saving}>
                {!activeId || newVersion ? 'Save as new version' : 'Save estimate'}
              </Button>
            </div>
          ) : null
        }
      >
        <div className="stack">
          {!canWrite ? (
            <Callout tone="grey">
              This sheet is read-only for your role — changing underwriting pricing requires the{' '}
              <span className="mono">estimate.write</span> permission.
            </Callout>
          ) : null}

          {canWrite && isReleased && !newVersion ? (
            <Callout tone="grey">
              <div className="row wrap">
                <span className="grow">
                  This quote was released to Sales and is no longer editable.
                </span>
                <Button size="sm" onClick={() => setNewVersion(true)}>
                  Create new version
                </Button>
              </div>
            </Callout>
          ) : null}

          {canWrite && newVersion && activeId ? (
            <Callout tone="blue">
              Saving will create a new version — the released quote stays exactly as it is.
            </Callout>
          ) : null}

          {saveErr ? <ErrorState error={saveErr} /> : null}

          {/* --------------------------- settings --------------------------- */}
          {canWrite ? (
            <>
              <div className="row wrap">
                <span className="tiny muted strong">SHEET TYPE</span>
                <Segmented<SheetInputs['sheet']>
                  options={[
                    { value: 'roofing', label: 'Roofing' },
                    { value: 'crew', label: 'Crew' },
                    { value: 'generic', label: 'Generic' },
                  ]}
                  value={inputs.sheet}
                  onChange={(v) => setInputs((s) => ({ ...s, sheet: v }))}
                />
              </div>
              <div className="form-grid">
                <NumCell
                  label="Tax rate %"
                  hint="Applied to taxable cost lines (materials)."
                  value={inputs.taxRate}
                  onCommit={(n) => setInputs((s) => ({ ...s, taxRate: n }))}
                />
                <NumCell
                  label="Commission %"
                  hint="Share of the selling price paid after gross profit."
                  value={inputs.commissionPct}
                  onCommit={(n) => setInputs((s) => ({ ...s, commissionPct: n }))}
                />
                <NumCell
                  label="Other expenses"
                  hint="Fixed overhead deducted after commission."
                  value={inputs.otherExpenses}
                  onCommit={(n) => setInputs((s) => ({ ...s, otherExpenses: n }))}
                />
                <NumCell
                  label="Area (sq ft)"
                  hint="Drives the price-per-square-foot figure."
                  value={inputs.areaSqft ?? 0}
                  onCommit={(n) => setInputs((s) => ({ ...s, areaSqft: n }))}
                />
              </div>
            </>
          ) : (
            <KeyValue
              items={[
                ['Sheet', titleCase(inputs.sheet)],
                ['Tax rate', pctRaw(inputs.taxRate, 2)],
                ['Commission', pctRaw(inputs.commissionPct, 2)],
                ['Other expenses', money2(inputs.otherExpenses)],
                ['Area', inputs.areaSqft ? `${num(inputs.areaSqft)} sq ft` : '—'],
              ]}
            />
          )}

          {/* --------------------------- live calc --------------------------- */}
          {previewError ? <div className="error-state">{previewError}</div> : null}

          <div className="grid grid-4">
            <Stat label="Selling price" value={money2(calc?.sellingPrice)} tone="accent" />
            <Stat label="Hard cost" value={money2(calc?.hardCost)} />
            <Stat
              label="Gross margin"
              value={pct(calc?.grossMargin)}
              tone={typeof calc?.grossMargin === 'number' ? (calc.grossMargin < 0 ? 'bad' : 'good') : undefined}
            />
            <Stat
              label="Net margin"
              value={pct(calc?.netMargin)}
              tone={typeof calc?.netMargin === 'number' ? (calc.netMargin < 0 ? 'bad' : 'good') : undefined}
            />
          </div>

          <KeyValue
            items={[
              ['Sell subtotal', money2(calc?.sellSubtotal)],
              ['Cost subtotal', money2(calc?.costSubtotal)],
              ['Tax', money2(calc?.tax)],
              ['Commission', money2(calc?.commission)],
              ['Gross profit', money2(calc?.grossProfit)],
              ['Net profit', money2(calc?.netProfit)],
              ['Markup on cost', pct(calc?.markup)],
              ['Price / sq ft', money2(calc?.pricePerSqft)],
              ['Price / square', money2(calc?.pricePerSquare)],
            ]}
          />

          {Array.isArray(calc?.flags) && calc.flags.length ? (
            <div className="stack" style={{ gap: 6 }}>
              {calc.flags.map((f: any, i: number) => (
                <div key={i} className={`${f.level === 'bad' ? 'error-state' : 'warn-state'} small`}>
                  {String(f.message ?? f.code ?? 'Pricing warning.')}
                </div>
              ))}
            </div>
          ) : null}

          {benchmarkFlags.length ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="tiny muted strong">BENCHMARK FLAGS</div>
              {benchmarkFlags.map((f: any, i: number) => (
                <div key={String(f.benchmarkId ?? i)} className="warn-state small">
                  <strong>{String(f.label ?? 'Benchmark')}</strong> — observed {num(f.value, 2)}{' '}
                  {titleCase(String(f.unit ?? ''))} is {f.direction === 'over' ? 'above' : 'below'}{' '}
                  the configured range
                  {f.min != null || f.max != null ? ` (${f.min ?? '—'}–${f.max ?? '—'})` : ''}.
                </div>
              ))}
            </div>
          ) : null}

          {/* ------------------------ margin floor gate ---------------------- */}
          {margin?.below ? (
            <div className="warn-state">
              {margin.actual === null ? (
                /* No selling price yet: the gate reports "below", but there is no margin to show. */
                <>
                  <strong>Nothing is priced yet — the margin floor cannot be cleared.</strong>
                  <div className="small" style={{ marginTop: 6 }}>
                    Add selling lines so the sheet produces a price; the floor is {pct(margin.floor)} for
                    this trade.
                  </div>
                </>
              ) : (
                <>
                  <div className="row wrap">
                    <strong>
                      Below the margin floor — Actual {pct(margin.actual)} vs {pct(margin.floor)} floor
                    </strong>
                    <Badge tone="amber">{titleCase(margin.metric)} margin</Badge>
                    <span className="spacer" />
                    {canRequest ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          setReason('');
                          setReasonErr(null);
                          setExceptionOpen(true);
                        }}
                        disabled={!activeId}
                        title={!activeId ? 'Save the estimate first, then request an exception.' : undefined}
                      >
                        Request margin exception
                      </Button>
                    ) : null}
                  </div>
                  <div className="small" style={{ marginTop: 6 }}>
                    {margin.metric === 'net'
                      ? 'Net margin is the checked metric because commission is configured.'
                      : 'Gross margin is the checked metric.'}{' '}
                    {activeId
                      ? 'Release stays blocked until an exception is approved or pricing is raised.'
                      : 'Save the estimate before requesting an exception.'}
                  </div>
                </>
              )}
            </div>
          ) : null}

          {/* --------------------------- approvals --------------------------- */}
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny muted strong">MARGIN EXCEPTIONS</div>
            {approvals.length === 0 ? (
              <div className="small muted">No exception has been requested for this bid.</div>
            ) : (
              <div className="list">
                {approvals.map((a: any) => (
                  <div className="list-item" key={a.id}>
                    <div className="grow">
                      <div className="row wrap">
                        <Badge tone={approvalTone(a.status)}>{titleCase(String(a.status ?? ''))}</Badge>
                        <span className="small strong">
                          {pctRaw(a.requested_margin)} vs {pctRaw(a.floor_margin)} floor
                        </span>
                      </div>
                      <div className="small">{a.reason || '—'}</div>
                      <div className="tiny muted">
                        Requested {dateTime(a.requested_at)}
                        {a.decided_by_name ? ` · decided by ${a.decided_by_name}` : ''}
                        {a.decision_note ? ` — ${a.decision_note}` : ''}
                      </div>
                    </div>
                    {canApprove && a.status === 'pending' ? (
                      <div className="row">
                        <Button
                          size="sm"
                          variant="success"
                          loading={deciding === a.id}
                          onClick={() => decide(a, 'approved')}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          loading={deciding === a.id}
                          onClick={() => decide(a, 'rejected')}
                        >
                          Reject
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* --------------------------- selling lines ----------------------- */}
          <div className="row wrap">
            <strong>Selling lines</strong>
            <span className="small muted">
              {inputs.sellLines.length} line(s) · subtotal {money2(calc?.sellSubtotal ?? inputs.sellLines.reduce((s, l) => s + l.qty * l.unitPrice, 0))}
            </span>
          </div>
          {inputs.sellLines.length === 0 ? (
            <EmptyState title="No selling lines yet" icon={<span>$</span>}>
              Add the lines that make up the contract price.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th>Unit</th>
                    <th className="num">Unit price</th>
                    <th className="num">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inputs.sellLines.map((line, i) => (
                    <LineRow
                      key={line.id ?? i}
                      line={line}
                      kind="sell"
                      editable={editable}
                      categories={categoryOptions}
                      onChange={(next) =>
                        setInputs((s) => ({
                          ...s,
                          sellLines: s.sellLines.map((l) => (l === line ? next : l)),
                        }))
                      }
                      onRemove={() =>
                        setInputs((s) => ({ ...s, sellLines: s.sellLines.filter((l) => l !== line) }))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <Button size="sm" onClick={addSellLine} disabled={!editable}>
              + Add line
            </Button>
          </div>

          {/* ---------------------------- cost lines ------------------------- */}
          <div className="row wrap">
            <strong>Cost lines</strong>
            <span className="small muted">
              {inputs.costLines.length} line(s) · hard cost {money2(calc?.hardCost ?? inputs.costLines.reduce((s, l) => s + l.qty * l.unitPrice, 0))}
            </span>
          </div>
          {inputs.costLines.length === 0 ? (
            <EmptyState title="No cost lines yet" icon={<span>🧾</span>}>
              Labor, materials, subs and equipment drive the margin floor check.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th>Unit</th>
                    <th className="num">Unit price</th>
                    <th>Category</th>
                    <th>Taxable</th>
                    <th className="num">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {inputs.costLines.map((line, i) => (
                    <LineRow
                      key={line.id ?? i}
                      line={line}
                      kind="cost"
                      editable={editable}
                      categories={categoryOptions}
                      onChange={(next) =>
                        setInputs((s) => ({
                          ...s,
                          costLines: s.costLines.map((l) => (l === line ? next : l)),
                        }))
                      }
                      onRemove={() =>
                        setInputs((s) => ({ ...s, costLines: s.costLines.filter((l) => l !== line) }))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <Button size="sm" onClick={addCostLine} disabled={!editable}>
              + Add line
            </Button>
          </div>

          {/* ------------------- narrative (release gate) ------------------- */}
          {canWrite ? (
            <div className="form-grid">
              <TextArea
                className="span-2"
                label="Scope of work"
                rows={4}
                value={inputs.scopeText}
                onChange={(e) => setInputs((s) => ({ ...s, scopeText: e.target.value }))}
                hint={scopeShort ? undefined : `${inputs.scopeText.trim().length} characters.`}
                error={
                  scopeShort
                    ? `${inputs.scopeText.trim().length} / 20 characters — the release gate blocks a shorter scope of work.`
                    : undefined
                }
                placeholder="What exactly will be furnished and installed?"
              />
              <TextArea
                className="span-2"
                label="Exclusions"
                rows={3}
                value={inputs.exclusionsText}
                onChange={(e) => setInputs((s) => ({ ...s, exclusionsText: e.target.value }))}
                hint={exclShort ? undefined : `${inputs.exclusionsText.trim().length} characters.`}
                error={
                  exclShort
                    ? `${inputs.exclusionsText.trim().length} / 5 characters — the release gate blocks empty exclusions.`
                    : undefined
                }
                placeholder="What is explicitly NOT included?"
              />
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny muted strong">SCOPE OF WORK</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {inputs.scopeText || '—'}
              </div>
              <div className="tiny muted strong">EXCLUSIONS</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {inputs.exclusionsText || '—'}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ----------------------- target price calculator --------------------- */}
      <Card title="Target price calculator" sub="What must we charge to hit a target margin?">
        <div className="stack">
          <Segmented<'gross' | 'net'>
            options={[
              { value: 'gross', label: 'Gross margin' },
              { value: 'net', label: 'Net margin' },
            ]}
            value={target.metric}
            onChange={(v) => setTarget((t) => ({ ...t, metric: v }))}
          />
          <div className="form-grid">
            <Input
              label="Target margin %"
              type="number"
              step="0.1"
              required
              value={target.targetMarginPct}
              onChange={(e) => setTarget((t) => ({ ...t, targetMarginPct: e.target.value }))}
            />
            <Input
              label="Hard cost"
              type="number"
              step="0.01"
              value={target.hardCost}
              placeholder={typeof calc?.hardCost === 'number' ? money2(calc.hardCost) : '—'}
              onFocus={() => setHardCostTouched(true)}
              onChange={(e) => {
                setHardCostTouched(true);
                setTarget((t) => ({ ...t, hardCost: e.target.value }));
              }}
            />
            <Input
              label="Commission %"
              type="number"
              step="0.1"
              value={target.commissionPct}
              onChange={(e) => setTarget((t) => ({ ...t, commissionPct: e.target.value }))}
            />
            <Input
              label="Other expenses"
              type="number"
              step="0.01"
              value={target.otherExpenses}
              onChange={(e) => setTarget((t) => ({ ...t, otherExpenses: e.target.value }))}
            />
          </div>
          <div className="row wrap">
            <Button
              variant="primary"
              onClick={runTargetPrice}
              loading={targetPending}
              disabled={!canWrite || target.targetMarginPct.trim() === ''}
              title={!canWrite ? 'The estimate.write permission is required.' : undefined}
            >
              Calculate price
            </Button>
            {typeof calc?.sellingPrice === 'number' ? (
              <span className="small muted">Current selling price {money2(calc.sellingPrice)}</span>
            ) : null}
          </div>

          {targetErr ? <ErrorState error={targetErr} /> : null}

          {targetResult ? (
            <div className="success-state">
              <div className="tiny">SUGGESTED PRICE · {titleCase(target.metric)} MARGIN</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>
                {money2(targetResult.price)}
              </div>
              <div className="small">
                Gross {pctRaw(targetResult.grossMarginPct)} · Net {pctRaw(targetResult.netMarginPct)}{' '}
                · Commission {money2(targetResult.commission)}
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {exceptionOpen && activeId ? (
        <Modal
          title="Request a margin exception"
          sub="An approver must sign off before a below-floor quote can be released."
          onClose={() => setExceptionOpen(false)}
          footer={
            <FormActions>
              <Button onClick={() => setExceptionOpen(false)} disabled={requesting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submitException}
                loading={requesting}
                disabled={reason.trim().length < 10}
              >
                Send request
              </Button>
            </FormActions>
          }
        >
          <div className="stack">
            {reasonErr ? <ErrorState error={reasonErr} /> : null}
            <TextArea
              label="Reason"
              required
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint={`${reason.trim().length} / 10 characters minimum — why is this still the right price?`}
              placeholder="Material take includes a premium assembly the client approved on site."
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ------------------------------ line rows ------------------------------ */

function LineRow({
  line,
  kind,
  editable,
  categories,
  onChange,
  onRemove,
}: {
  line: SheetLine;
  kind: 'sell' | 'cost';
  editable: boolean;
  categories: Array<{ value: string; label: string }>;
  onChange: (next: SheetLine) => void;
  onRemove: () => void;
}) {
  const amount = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
  return (
    <tr>
      <td style={{ minWidth: 180 }}>
        {editable ? (
          <Input
            aria-label="Line description"
            value={line.description}
            placeholder="Description"
            onChange={(e) => onChange({ ...line, description: e.target.value })}
          />
        ) : (
          line.description || <span className="muted">—</span>
        )}
      </td>
      <td className="num" style={{ width: 100 }}>
        {editable ? (
          <NumCell
            ariaLabel="Quantity"
            value={line.qty}
            onCommit={(n) => onChange({ ...line, qty: n })}
          />
        ) : (
          num(line.qty, 2)
        )}
      </td>
      <td style={{ width: 80 }}>
        {editable ? (
          <Input
            aria-label="Unit"
            value={line.unit}
            onChange={(e) => onChange({ ...line, unit: e.target.value })}
          />
        ) : (
          line.unit || '—'
        )}
      </td>
      <td className="num" style={{ width: 120 }}>
        {editable ? (
          <NumCell
            ariaLabel="Unit price"
            value={line.unitPrice}
            onCommit={(n) => onChange({ ...line, unitPrice: n })}
          />
        ) : (
          money2(line.unitPrice)
        )}
      </td>
      {kind === 'cost' ? (
        <>
          <td style={{ minWidth: 150 }}>
            {editable ? (
              <Select
                aria-label="Cost category"
                value={String(line.categoryKey ?? 'other')}
                options={categories}
                onChange={(e) =>
                  onChange({
                    ...line,
                    categoryKey: e.target.value,
                    // Materials are the taxable bucket by default.
                    taxable: e.target.value === 'materials' ? true : line.taxable,
                  })
                }
              />
            ) : (
              String(line.categoryKey ?? '—')
            )}
          </td>
          <td className="right">
            {editable ? (
              <Checkbox
                label=""
                aria-label="Taxable"
                checked={!!line.taxable}
                onChange={(e) => onChange({ ...line, taxable: e.target.checked })}
              />
            ) : line.taxable ? (
              'Yes'
            ) : (
              'No'
            )}
          </td>
        </>
      ) : null}
      <td className="num mono nowrap">{money2(amount)}</td>
      <td className="right">
        {editable ? (
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove line">
            ✕
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Numeric cell that keeps its own text so half-typed values ("1.", "") survive
 * a render; the parent only sees finished numbers.
 */
function NumCell({
  value,
  onCommit,
  label,
  hint,
  ariaLabel,
  step = 'any',
  disabled,
}: {
  value: number;
  onCommit: (n: number) => void;
  label?: string;
  hint?: ReactNode;
  ariaLabel?: string;
  step?: string;
  disabled?: boolean;
}) {
  const safe = Number.isFinite(value) ? String(value) : '';
  const [text, setText] = useState(safe);
  useEffect(() => {
    setText(Number.isFinite(value) ? String(value) : '');
  }, [value]);

  return (
    <Input
      label={label}
      hint={hint}
      aria-label={ariaLabel}
      type="number"
      step={step}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === '' || raw === '-') return;
        const n = Number(raw);
        if (Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => {
        if (text === '' || text === '-') setText(Number.isFinite(value) ? String(value) : '');
      }}
    />
  );
}

/* ================================================================== */
/* Estimate tab — versions and release                                 */
/* ================================================================== */

function EstimateTab({
  bidNo,
  estimates,
  approvals,
  canRelease,
  onChanged,
}: {
  bidNo: string;
  estimates: any[];
  approvals: any[];
  canRelease: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState<any | null>(null);
  const [check, setCheck] = useState<ReleaseCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  const close = () => {
    setTarget(null);
    setCheck(null);
    setCheckErr(null);
  };

  const runCheck = async (estimate: any) => {
    setTarget(estimate);
    setCheck(null);
    setCheckErr(null);
    setChecking(true);
    try {
      setCheck(await get<ReleaseCheck>(`/estimates/${estimate.id}/release-check`));
    } catch (e) {
      setCheckErr(errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const release = async () => {
    if (!target) return;
    setReleasing(true);
    try {
      await post(`/estimates/${target.id}/release`, {});
      toast.success('Quote released to Sales', `${bidNo} v${target.version} is now available to Sales.`);
      close();
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      toast.error('Release blocked', err.message);
      // Re-run the check so the panel shows the server's current gate result.
      await runCheck(target);
    } finally {
      setReleasing(false);
    }
  };

  const versionOf = (estimateId: any) => {
    const est = estimates.find((x: any) => x.id === estimateId);
    return est ? `v${est.version}` : '—';
  };

  return (
    <div className="stack">
      <Card title="Estimate versions" sub="One sheet per pricing pass; only one can be released" flush>
        {estimates.length === 0 ? (
          <EmptyState title="No estimates yet" icon={<span>🧮</span>}>
            Build the underwriting sheet, save it, and the version appears here for release.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th className="num">Selling price</th>
                  <th className="num">Gross margin</th>
                  <th className="num">Net margin</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {estimates.map((e: any) => (
                  <tr key={e.id}>
                    <td className="mono strong nowrap">
                      v{e.version}
                      {e.title ? <span className="tiny muted"> {e.title}</span> : null}
                    </td>
                    <td className="nowrap">
                      <Badge tone={estimateTone(e.status)}>{titleCase(String(e.status ?? ''))}</Badge>
                    </td>
                    <td className="num mono">{money2(e.calc?.sellingPrice)}</td>
                    <td className="num">{pct(e.calc?.grossMargin)}</td>
                    <td className="num">{pct(e.calc?.netMargin)}</td>
                    <td className="nowrap">{dateShort(e.created_at)}</td>
                    <td className="right nowrap">
                      {e.status === 'draft' ? (
                        <Button size="sm" onClick={() => runCheck(e)}>
                          Release to Sales
                        </Button>
                      ) : e.released_at ? (
                        <span className="tiny muted">Released {dateShort(e.released_at)}</span>
                      ) : (
                        <span className="tiny muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Margin exceptions" sub="Requests to price below the configured floor">
        {approvals.length === 0 ? (
          <div className="small muted">No margin exceptions have been requested for this bid.</div>
        ) : (
          <div className="list">
            {approvals.map((a: any) => (
              <div className="list-item" key={a.id}>
                <div className="grow">
                  <div className="row wrap">
                    <Badge tone={approvalTone(a.status)}>{titleCase(String(a.status ?? ''))}</Badge>
                    <span className="small strong">{versionOf(a.estimate_id)}</span>
                    <span className="small">
                      {pctRaw(a.requested_margin)} requested vs {pctRaw(a.floor_margin)} floor
                    </span>
                  </div>
                  <div className="small">{a.reason || '—'}</div>
                  <div className="tiny muted">
                    Requested {dateTime(a.requested_at)}
                    {a.decided_by_name ? ` · decided by ${a.decided_by_name}` : ''}
                    {a.decided_at ? ` on ${dateShort(a.decided_at)}` : ''}
                    {a.decision_note ? ` — ${a.decision_note}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {target ? (
        <Modal
          title={`Release ${bidNo} v${target.version} to Sales`}
          sub="Every release check must pass before the quote can be handed to Sales."
          onClose={close}
          footer={
            <FormActions>
              <Button onClick={close} disabled={releasing}>
                Cancel
              </Button>
              <Button
                variant="success"
                onClick={release}
                loading={releasing}
                disabled={checking || !check?.ok || !canRelease || !!check?.requiresApprovalRole}
                title={
                  !canRelease || check?.requiresApprovalRole
                    ? 'The estimate.release permission is required to release a quote.'
                    : !check?.ok
                      ? 'Resolve every blocker first.'
                      : undefined
                }
              >
                Release to Sales
              </Button>
            </FormActions>
          }
        >
          <div className="stack">
            {checking ? <Loading label="Running release checks…" /> : null}
            {checkErr ? <div className="error-state">{checkErr}</div> : null}

            {check && !check.ok ? (
              <>
                <div className="warn-state">
                  Not ready to release — {check.blockers.length} check
                  {check.blockers.length === 1 ? '' : 's'} still failing.
                </div>
                <BlockerList items={check.blockers.map((b) => ({ label: b.label, detail: b.detail }))} />
              </>
            ) : null}

            {check && check.ok ? (
              <div className="success-state">
                All release checks passed — selling price {money2(check.calc?.sellingPrice)} at{' '}
                {pct(check.calc?.netMargin ?? check.calc?.grossMargin)} margin (floor{' '}
                {pctRaw(check.marginFloor)}).
              </div>
            ) : null}

            {check?.requiresApprovalRole ? (
              <Callout tone="grey">
                Your role does not include the <span className="mono">estimate.release</span>{' '}
                permission, so the release button stays disabled even when every check passes.
              </Callout>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Sub quotes tab                                                      */
/* ================================================================== */

function SubQuotesTab({
  bidId,
  rows,
  canWrite,
  onChanged,
}: {
  bidId: string;
  rows: any[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [modal, setModal] = useState<{ open: boolean; row: any | null }>({ open: false, row: null });

  return (
    <div className="stack">
      <Card
        title="Sub quotes"
        sub="Pricing received from subcontractors and suppliers"
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setModal({ open: true, row: null })} icon={<Icon name="plus" size={14} />}>
              Add sub quote
            </Button>
          ) : null
        }
        flush
      >
        {rows.length === 0 ? (
          <EmptyState title="No sub quotes yet" icon={<span>🧾</span>}>
            Record quotes from subs and suppliers so their scope gaps show up before release.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num">Amount</th>
                  <th>Quote date</th>
                  <th>Valid until</th>
                  <th>Includes</th>
                  <th>Excludes</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{r.vendor_name || <span className="muted">—</span>}</td>
                    <td className="num mono">{money2(r.amount)}</td>
                    <td className="nowrap">{dateShort(r.quote_date)}</td>
                    <td className="nowrap">
                      {r.valid_until ? (
                        <>
                          <span>{dateShort(r.valid_until)}</span>
                          {Number(r.valid_until) < Date.now() ? (
                            <div className="tiny" style={{ color: 'var(--red)' }}>
                              expired
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="truncate" style={{ maxWidth: 180 }} title={r.includes || ''}>
                      {r.includes || <span className="muted">—</span>}
                    </td>
                    <td className="truncate" style={{ maxWidth: 180 }} title={r.excludes || ''}>
                      {r.excludes || <span className="muted">—</span>}
                    </td>
                    <td className="nowrap">
                      <Badge tone={subQuoteTone(r.status)}>{titleCase(String(r.status ?? ''))}</Badge>
                    </td>
                    <td className="right nowrap">
                      {canWrite ? (
                        <Button size="sm" onClick={() => setModal({ open: true, row: r })}>
                          Edit
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {modal.open ? (
        <SubQuoteModal
          bidId={bidId}
          row={modal.row}
          onClose={() => setModal({ open: false, row: null })}
          onSaved={() => {
            setModal({ open: false, row: null });
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function SubQuoteModal({
  bidId,
  row,
  onClose,
  onSaved,
}: {
  bidId: string;
  row: any | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(row?.amount === undefined || row?.amount === null ? '' : String(row.amount));
  const [quoteDate, setQuoteDate] = useState(dateInput(row?.quote_date));
  const [validUntil, setValidUntil] = useState(dateInput(row?.valid_until));
  const [includes, setIncludes] = useState(String(row?.includes ?? ''));
  const [excludes, setExcludes] = useState(String(row?.excludes ?? ''));
  const [status, setStatus] = useState(String(row?.status ?? 'requested'));
  const [vendorId, setVendorId] = useState(String(row?.vendor_id ?? ''));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const vendors = useFetch<{ rows: any[] }>(`/admin/vendors${qs({ limit: 100 })}`, []);

  const valid = amount !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0;

  const submit = async () => {
    if (!valid) return;
    setPending(true);
    setErr(null);
    try {
      const body = {
        amount: Number(amount),
        quoteDate: dateToMs(quoteDate),
        validUntil: dateToMs(validUntil),
        includes,
        excludes,
        status,
        // Omitted entirely when empty so PATCH leaves the stored vendor alone.
        vendorId: vendorId ? vendorId : undefined,
      };
      if (row) {
        await patch(`/bids/sub-quotes/${row.id}`, body);
        toast.success('Sub quote updated');
      } else {
        await post(`/bids/${bidId}/sub-quotes`, body);
        toast.success('Sub quote recorded');
      }
      onSaved();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={row ? 'Edit sub quote' : 'Add sub quote'}
      sub="Amounts feed the underwriting cost picture for this bid."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!valid}>
            {row ? 'Save changes' : 'Add sub quote'}
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? <ErrorState error={err} /> : null}
        <div className="form-grid">
          {vendors.data ? (
            <Select
              label="Vendor"
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              placeholder="Unassigned"
              error={err?.fieldErrors?.vendorId}
              options={(vendors.data.rows ?? []).map((v: any) => ({ value: v.id, label: v.name }))}
            />
          ) : null}
          <Input
            label="Amount"
            required
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={err?.fieldErrors?.amount}
          />
          <Input
            label="Quote date"
            type="date"
            value={quoteDate}
            onChange={(e) => setQuoteDate(e.target.value)}
            error={err?.fieldErrors?.quoteDate}
          />
          <Input
            label="Valid until"
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            error={err?.fieldErrors?.validUntil}
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'requested', label: 'Requested' },
              { value: 'received', label: 'Received' },
              { value: 'accepted', label: 'Accepted' },
              { value: 'declined', label: 'Declined' },
              { value: 'expired', label: 'Expired' },
            ]}
          />
        </div>
        <TextArea
          label="Includes"
          rows={2}
          value={includes}
          onChange={(e) => setIncludes(e.target.value)}
          placeholder="What the sub's price covers"
        />
        <TextArea
          label="Excludes"
          rows={2}
          value={excludes}
          onChange={(e) => setExcludes(e.target.value)}
          placeholder="What is left out — these become scope gaps"
        />
        {vendors.error ? (
          <p className="tiny muted">
            The vendor list could not be loaded ({errMsg(vendors.error)}) — the quote will be saved
            without a vendor link.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Plans tab                                                           */
/* ================================================================== */

function PlansTab({
  revisions,
  canWrite,
  onAdd,
}: {
  revisions: any[];
  canWrite: boolean;
  onAdd: () => void;
}) {
  return (
    <Card
      title="Plan revisions"
      sub="Takeoff quantities are always tied to the current revision"
      actions={
        canWrite ? (
          <Button size="sm" variant="primary" onClick={onAdd} icon={<Icon name="plus" size={14} />}>
            Add revision
          </Button>
        ) : null
      }
    >
      <div className="stack">
        <Callout tone="grey">
          Plan file bytes are not stored yet — each revision records metadata only (number, label,
          notes and who uploaded it). Uploading and serving the actual drawings lands in a later
          step.
        </Callout>

        {revisions.length === 0 ? (
          <EmptyState title="No revisions yet" icon={<span>📐</span>}>
            Add the first revision to give takeoff something to measure against.
          </EmptyState>
        ) : (
          <div className="list">
            {revisions.map((r) => (
              <div className="list-item" key={r.id}>
                <span className="mono strong nowrap">R{r.revision_no}</span>
                <div className="grow">
                  <div className="strong small">{r.label || 'Untitled revision'}</div>
                  {r.notes ? <div className="tiny muted">{r.notes}</div> : null}
                </div>
                {r.is_current ? <Badge tone="green">Current</Badge> : null}
                <span className="tiny muted nowrap">{dateShort(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ================================================================== */
/* Shared modals                                                       */
/* ================================================================== */

function PlanModal({
  bidId,
  onClose,
  onSaved,
}: {
  bidId: string;
  onClose: () => void;
  onSaved: (row: any) => void;
}) {
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const submit = async () => {
    if (!label.trim()) return;
    setPending(true);
    setErr(null);
    try {
      const res = await post<{ row: any }>(`/bids/${bidId}/plans`, { label: label.trim(), notes });
      onSaved(res.row);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Add plan revision"
      sub="The new revision becomes the current one; older revisions stay for history."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!label.trim()}>
            Add revision
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? <ErrorState error={err} /> : null}
        <Input
          label="Label"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Issued for construction"
          error={err?.fieldErrors?.label}
        />
        <TextArea
          label="Notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What changed in this revision?"
          error={err?.fieldErrors?.notes}
        />
        <Callout tone="grey">
          File bytes are not stored yet — this records the revision metadata only.
        </Callout>
      </div>
    </Modal>
  );
}

function EditBidModal({
  bid,
  dispositions,
  onClose,
  onSaved,
}: {
  bid: any;
  dispositions: any[];
  onClose: () => void;
  onSaved: (row: any) => void;
}) {
  const roster = useFetch<{ rows: any[] }>('/auth/roster', []);
  const [projectAddress, setProjectAddress] = useState(String(bid.project_address ?? ''));
  const [scopeSummary, setScopeSummary] = useState(String(bid.scope_summary ?? ''));
  const [estimatorId, setEstimatorId] = useState(String(bid.estimator_id ?? ''));
  const [quoteDueAt, setQuoteDueAt] = useState(dateInput(bid.quote_due_at));
  const [temperature, setTemperature] = useState(String(bid.temperature ?? 'warm'));
  const [dispositionId, setDispositionId] = useState(String(bid.disposition_id ?? ''));
  const [takeoffRequired, setTakeoffRequired] = useState(bid.takeoff_required === 1);
  const [performMode, setPerformMode] = useState(String(bid.perform_mode ?? 'self'));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  const submit = async () => {
    setPending(true);
    setErr(null);
    try {
      const res = await patch<{ row: any }>(`/bids/${bid.id}`, {
        projectAddress,
        scopeSummary,
        estimatorId: estimatorId ? estimatorId : null,
        quoteDueAt: dateToMs(quoteDueAt),
        temperature,
        dispositionId: dispositionId ? dispositionId : null,
        takeoffRequired,
        // The update schema names this field perform_mode; camelCase is dropped.
        perform_mode: performMode,
      });
      onSaved(res.row);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={`Edit ${bid.bid_no ?? 'bid'}`}
      sub="Stage changes use the Advance button so the one-step rule stays obvious."
      onClose={onClose}
      footer={
        <FormActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={pending}>
            Save changes
          </Button>
        </FormActions>
      }
    >
      <div className="stack">
        {err ? <ErrorState error={err} /> : null}
        <div className="form-grid">
          <Input
            label="Project address"
            value={projectAddress}
            onChange={(e) => setProjectAddress(e.target.value)}
            error={err?.fieldErrors?.projectAddress}
          />
          <Input
            label="Quote due"
            type="date"
            value={quoteDueAt}
            onChange={(e) => setQuoteDueAt(e.target.value)}
            error={err?.fieldErrors?.quoteDueAt}
          />
          <Select
            label="Estimator"
            value={estimatorId}
            onChange={(e) => setEstimatorId(e.target.value)}
            placeholder="Unassigned"
            error={err?.fieldErrors?.estimatorId}
            options={(roster.data?.rows ?? []).map((u: any) => ({ value: u.id, label: u.name }))}
          />
          <Select
            label="Temperature"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            options={[
              { value: 'hot', label: 'Hot' },
              { value: 'warm', label: 'Warm' },
              { value: 'cold', label: 'Cold' },
            ]}
          />
          <Select
            label="Disposition"
            value={dispositionId}
            onChange={(e) => setDispositionId(e.target.value)}
            placeholder="None"
            error={err?.fieldErrors?.dispositionId}
            options={dispositions.map((d: any) => ({ value: d.id, label: d.name }))}
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
          <div className="field span-2">
            <label htmlFor="edit-bid-scope">Scope summary</label>
            <TextArea
              id="edit-bid-scope"
              rows={3}
              value={scopeSummary}
              onChange={(e) => setScopeSummary(e.target.value)}
              error={err?.fieldErrors?.scopeSummary}
            />
          </div>
          <div className="field">
            <label>Takeoff</label>
            <Checkbox
              label="Takeoff required"
              checked={takeoffRequired}
              onChange={(e) => setTakeoffRequired(e.target.checked)}
            />
          </div>
        </div>
        {roster.error ? (
          <p className="tiny muted">Roster unavailable: {errMsg(roster.error)}</p>
        ) : null}
      </div>
    </Modal>
  );
}
