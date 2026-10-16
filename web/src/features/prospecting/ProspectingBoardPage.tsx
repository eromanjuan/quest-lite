import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, qs, ApiError } from '../../lib/api';
import { useAction, useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Kanban,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Segmented,
  Select,
  TemperatureDot,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  TEMPERATURE_LABELS,
  TRADE_LABELS,
  fromLocalInputValue,
  rel,
  titleCase,
} from '../../lib/format';

type StageKey = 'prospect' | 'lead' | 'nurturing';

const STAGES: Array<{ key: StageKey; label: string }> = [
  { key: 'prospect', label: 'Prospect' },
  { key: 'lead', label: 'Lead' },
  { key: 'nurturing', label: 'Nurturing' },
];

const TEMPS = ['hot', 'warm', 'cold'] as const;

/** Same colours the temp dots use, so the card edge and the dot agree. */
const TEMP_EDGE: Record<string, string> = {
  hot: 'var(--red)',
  warm: 'var(--accent-2)',
  cold: 'var(--blue)',
};

interface PRow {
  id: string;
  stage?: string | null;
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

/** Date inputs hand back "YYYY-MM-DD"; pin it to local midnight so the day survives formatting. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

/* ------------------------------------------------------------------ */
/* Filter state + bar (duplicated in the table page: only four files   */
/* may exist in this folder, so there is no shared prospect module).   */
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
/* Board                                                               */
/* ------------------------------------------------------------------ */

export default function ProspectingBoardPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const f = useProspectFilters();
  const [showNew, setShowNew] = useState(false);
  const canWrite = can('prospect.write');

  const config = useFetch<ConfigData>('/config');
  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');

  const path = `/prospects${qs({ ...f.query, limit: 500 })}`;
  const list = useFetch<{ rows: PRow[]; total: number; limit: number; offset: number }>(path, [
    path,
  ]);

  const rows = list.data?.rows ?? [];
  const overdueCount = rows.filter(
    (r) => r.next_followup_at != null && Number(r.next_followup_at) < Date.now(),
  ).length;
  const handedOff = rows.filter((r) => r.handoff_at != null).length;

  const byStage: Record<string, PRow[]> = { prospect: [], lead: [], nurturing: [] };
  for (const r of rows) {
    const key = STAGES.some((s) => s.key === r.stage) ? String(r.stage) : 'prospect';
    byStage[key].push(r);
  }
  const columns = STAGES.map((s) => ({ key: s.key, label: s.label, items: byStage[s.key] }));

  const timingName = (key?: string | null): string => {
    if (!key) return '—';
    return (config.data?.timingBuckets ?? []).find((b: any) => b.key === key)?.name ?? titleCase(key);
  };

  const onDrop = async (id: string, columnKey: string) => {
    try {
      await post(`/prospects/${id}/move`, { stage: columnKey });
      list.reload();
      return true;
    } catch (err) {
      if (err instanceof ApiError) toast.error('Move rejected', err.message);
      else toast.error('Move rejected', err instanceof Error ? err.message : 'Something went wrong.');
      // Server truth wins: redraw the board so the card rolls back.
      list.reload();
      return false;
    }
  };

  const sub = list.data
    ? `${list.data.total} prospects · ${overdueCount} overdue follow-ups · ${handedOff} handed off`
    : 'Loading the pipeline…';

  let body: ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading prospects…" />;
  } else if (rows.length === 0) {
    body = f.active ? (
      <EmptyState title="No prospects match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the filters to see the whole board again.
      </EmptyState>
    ) : (
      <EmptyState
        title="No prospects yet"
        icon={<Icon name="prospects" size={22} />}
        action={
          <Button variant="primary" onClick={() => setShowNew(true)}>
            Create your first prospect
          </Button>
        }
      >
        Every prospect starts here: a contact, a scope, and a first follow-up date.
      </EmptyState>
    );
  } else {
    body = (
      <Kanban
        columns={columns}
        getId={(p) => p.id}
        disabled={!canWrite}
        canDrag={() => canWrite}
        onOpen={(p) => navigate(`/prospects/${p.id}`)}
        onDrop={onDrop}
        emptyLabel="Nothing in this stage."
        renderCard={(p) => {
          const overdue = p.next_followup_at != null && Number(p.next_followup_at) < Date.now();
          const name =
            `${p.contact_first ?? ''} ${p.contact_last ?? ''}`.trim() || '—';
          const scope = p.scope_summary || p.project_address || '—';
          const tempLabel = p.temperature
            ? TEMPERATURE_LABELS[p.temperature] ?? titleCase(p.temperature)
            : '—';
          return (
            // The Kanban owns the card element, so temperature is expressed on this wrapper.
            <div
              style={{
                borderLeft: `3px solid ${TEMP_EDGE[p.temperature ?? ''] ?? 'var(--line-2)'}`,
                paddingLeft: 8,
              }}
            >
              <div className="row">
                <TemperatureDot value={p.temperature ?? ''} />
                <b className="grow truncate" title={name}>
                  {name}
                </b>
              </div>
              <div className="sub truncate" title={p.company_name ?? ''}>
                {p.company_name ?? '—'}
              </div>
              <div className="title truncate" title={scope}>
                {scope}
              </div>
              <div className="meta">
                <span className="tiny muted">{tempLabel}</span>
                {p.disposition_name ? <Badge tone="outline">{p.disposition_name}</Badge> : null}
                {p.timing ? <Badge tone="blue">{timingName(p.timing)}</Badge> : null}
                {p.source_name ? <Badge tone="neutral">{p.source_name}</Badge> : null}
              </div>
              <div className="foot">
                <span
                  className={overdue ? 'strong' : ''}
                  style={overdue ? { color: 'var(--red)' } : undefined}
                >
                  {overdue ? `Overdue · ${rel(p.next_followup_at)}` : `Follow-up ${rel(p.next_followup_at)}`}
                </span>
                <span>
                  {p.open_tasks != null
                    ? `${p.open_tasks} open task${Number(p.open_tasks) === 1 ? '' : 's'}`
                    : '—'}
                </span>
                {p.bid_no ? (
                  <Badge tone="violet" title="Handed off to Underwriting">
                    {p.bid_no}
                  </Badge>
                ) : null}
              </div>
            </div>
          );
        }}
      />
    );
  }

  return (
    <>
      <PageHead
        title="Prospecting"
        sub={sub}
        actions={
          <>
            <LinkButton to="/prospecting/table" size="sm" icon={<Icon name="file" size={14} />}>
              Table view
            </LinkButton>
            <LinkButton to="/call-queue" size="sm" icon={<Icon name="phone" size={14} />}>
              Call queue
            </LinkButton>
            <Button
              variant="primary"
              size="sm"
              disabled={!canWrite}
              title={canWrite ? undefined : 'You do not have permission to create prospects.'}
              icon={<Icon name="plus" size={14} />}
              onClick={() => setShowNew(true)}
            >
              New prospect
            </Button>
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

      {f.active && rows.length > 0 ? (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small muted">
            {rows.length} of {list.data?.total ?? rows.length} shown
          </span>
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={f.reset}>
            Clear filters
          </Button>
        </div>
      ) : null}

      {body}

      {showNew ? (
        <NewProspectModal
          config={config.data}
          roster={roster.data?.rows ?? []}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* New prospect                                                        */
/* ------------------------------------------------------------------ */

const FORM_ID = 'new-prospect-form';

function NewProspectModal({
  config,
  roster,
  onClose,
  onCreated,
}: {
  config: ConfigData | null;
  roster: RosterRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [contactId, setContactId] = useState('');
  const [contactQ, setContactQ] = useState('');
  const dq = useDebounced(contactQ, 300);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [isDecisionMaker, setIsDecisionMaker] = useState(false);
  const [consentSms, setConsentSms] = useState(false);

  const [scopeSummary, setScopeSummary] = useState('');
  const [projectAddress, setProjectAddress] = useState('');
  const [trade, setTrade] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [territoryId, setTerritoryId] = useState('');
  const [temperature, setTemperature] = useState<'hot' | 'warm' | 'cold'>('warm');
  const [timing, setTiming] = useState('within_month');
  const [firstFollowUp, setFirstFollowUp] = useState('');
  const [ownerId, setOwnerId] = useState('');

  const contacts = useFetch<{ rows: any[]; total: number }>(
    mode === 'existing' ? `/contacts${qs({ q: dq, limit: 50 })}` : null,
    [mode, dq],
  );

  const buildBody = () => {
    const body: Record<string, any> = {
      scopeSummary: scopeSummary.trim(),
      projectAddress: projectAddress.trim(),
      temperature,
      timing,
    };
    if (mode === 'existing') {
      body.contactId = contactId;
    } else {
      body.newContact = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || null,
        mobile: mobile.trim() || null,
        email: email.trim() || null,
        isDecisionMaker,
        consentSms,
      };
    }
    if (trade) body.trade = trade;
    if (sourceId) body.sourceId = sourceId;
    if (territoryId) body.territoryId = territoryId;
    if (ownerId) body.ownerId = ownerId;
    const fu = dateToMs(firstFollowUp);
    if (fu != null) body.firstFollowUpAt = fu;
    return body;
  };

  const action = useAction(() => post('/prospects', buildBody()));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    // The footer button lives outside the <form>, so validity is checked here
    // as well — both paths end in exactly one request.
    const form = document.getElementById(FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const res = await action.run();
    if (res) {
      toast.success('Prospect created');
      onCreated();
    }
    // Errors stay in the dialog: action.error.message is rendered below.
  };

  return (
    <Modal
      title="New prospect"
      sub="Attach an existing contact or create one inline — an opportunity and a first follow-up are created with it."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={action.pending} onClick={submit}>
            Create prospect
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create prospect
        </button>
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}

        <Field label="Contact">
          <Segmented
            options={[
              { value: 'new', label: 'New contact' },
              { value: 'existing', label: 'Existing contact' },
            ]}
            value={mode}
            onChange={(v) => setMode(v)}
          />
        </Field>

        {mode === 'existing' ? (
          <>
            <Input
              type="search"
              aria-label="Search contacts"
              className="input-sm"
              placeholder="Search contacts by name, phone or email…"
              value={contactQ}
              onChange={(e) => setContactQ(e.target.value)}
            />
            {contacts.error ? <ErrorState error={contacts.error} onRetry={contacts.reload} /> : null}
            <Select
              label="Contact"
              required
              disabled={contacts.loading}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              placeholder={
                contacts.loading
                  ? 'Loading contacts…'
                  : (contacts.data?.rows ?? []).length === 0
                    ? 'No contacts match'
                    : 'Select a contact'
              }
              options={(contacts.data?.rows ?? []).map((c: any) => ({
                value: c.id,
                label: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unnamed contact',
              }))}
            />
            {contacts.data && (contacts.data.rows ?? []).length === 0 ? (
              <div className="info-state">
                No contacts match that search — switch to “New contact” to create one.
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="form-grid">
              <Input
                label="First name"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
              <Input
                label="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
              <Input
                label="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
              />
              <Input
                label="Mobile"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                autoComplete="tel"
              />
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="row wrap">
              <Checkbox
                label="Is the decision-maker"
                checked={isDecisionMaker}
                onChange={(e) => setIsDecisionMaker(e.target.checked)}
              />
              <Checkbox
                label="Consents to SMS"
                checked={consentSms}
                onChange={(e) => setConsentSms(e.target.checked)}
              />
            </div>
          </>
        )}

        <TextArea
          label="Scope of work"
          required
          placeholder="Tear off and replace 40 squares of flat roof, two drains, one skylight."
          value={scopeSummary}
          onChange={(e) => setScopeSummary(e.target.value)}
        />
        <Input
          label="Project address"
          required
          placeholder="1200 Industrial Row, Unit 4"
          value={projectAddress}
          onChange={(e) => setProjectAddress(e.target.value)}
        />

        <div className="form-grid">
          <Select
            label="Trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            placeholder="Unset"
            options={(config?.trades ?? []).map((t: string) => ({
              value: t,
              label: TRADE_LABELS[t] ?? titleCase(t),
            }))}
          />
          <Select
            label="Lead source"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            placeholder="Unset"
            options={(config?.leadSources ?? []).map((s: any) => ({ value: s.id, label: s.name }))}
          />
          <Select
            label="Territory"
            value={territoryId}
            onChange={(e) => setTerritoryId(e.target.value)}
            placeholder="Unset"
            options={(config?.territories ?? []).map((t: any) => ({ value: t.id, label: t.name }))}
          />
          <Select
            label="Timing"
            value={timing}
            onChange={(e) => setTiming(e.target.value)}
            options={(config?.timingBuckets ?? []).map((b: any) => ({ value: b.key, label: b.name }))}
          />
          <Input
            label="First follow-up"
            type="date"
            value={firstFollowUp}
            onChange={(e) => setFirstFollowUp(e.target.value)}
            hint="Defaults from the timing bucket when left empty."
          />
          <Select
            label="Owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            placeholder="Me"
            options={roster.map((r) => ({ value: r.id, label: r.name }))}
          />
        </div>

        <Field label="Temperature">
          <Segmented
            options={TEMPS.map((t) => ({ value: t, label: TEMPERATURE_LABELS[t] ?? titleCase(t) }))}
            value={temperature}
            onChange={(v) => setTemperature(v)}
          />
        </Field>
      </form>
    </Modal>
  );
}
