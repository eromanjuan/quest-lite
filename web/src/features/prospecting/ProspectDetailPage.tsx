import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { patch, post, ApiError } from '../../lib/api';
import { useAction, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import { CommunicationPanel } from '../records/CommunicationPanel';
import { ContactCard } from '../records/ContactCard';
import {
  Badge,
  BlockerList,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  KeyValue,
  LinkButton,
  Loading,
  Modal,
  PageHead,
  Select,
  Tabs,
  TemperatureDot,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  TEMPERATURE_LABELS,
  TRADE_LABELS,
  date,
  dateTime,
  fromLocalInputValue,
  rel,
  stageLabel,
  titleCase,
  toLocalInputValue,
} from '../../lib/format';

interface DetailData {
  row: any;
  tasks: any[];
  communications: any[];
  documents: any[];
  opportunity: any | null;
}

interface QualData {
  ok: boolean;
  items: Array<{ key?: string; label: string; met: boolean; required: boolean; hint?: string }>;
  blockers?: any;
  existingBid?: any;
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

const TASK_TYPES = [
  ['follow_up', 'Follow up'],
  ['call', 'Call'],
  ['text', 'Text'],
  ['email', 'Email'],
  ['site_visit', 'Site visit'],
  ['document', 'Document'],
  ['task', 'Task'],
] as const;

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Date inputs hand back "YYYY-MM-DD"; pin it to local midnight so the day survives formatting. */
const dateToMs = (v: string) => (v ? fromLocalInputValue(`${v}T00:00`) : null);

export default function ProspectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const detail = useFetch<DetailData>(id ? `/prospects/${id}` : null, [id]);
  const qual = useFetch<QualData>(id ? `/prospects/${id}/qualification` : null, [id]);
  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');
  const config = useFetch<ConfigData>('/config');

  const [tab, setTab] = useState('tasks');
  const [showEdit, setShowEdit] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const [followUp, setFollowUp] = useState('');
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const row = detail.data?.row ?? null;
  const nextFollowupAt = row?.next_followup_at ?? null;

  // Keep the inline editor in step with the record whenever the server re-sends it.
  useEffect(() => {
    setFollowUp(nextFollowupAt != null ? toLocalInputValue(nextFollowupAt).slice(0, 10) : '');
  }, [nextFollowupAt]);

  const canWrite = can('prospect.write');
  const canHandoff = can('prospect.write') && can('prospect.handoff');
  const canTask = can('task.write');

  const saveFollowUp = async () => {
    setSavingFollowUp(true);
    setFollowUpError(null);
    try {
      await patch(`/prospects/${id}`, { nextFollowupAt: followUp ? dateToMs(followUp) : null });
      toast.success('Follow-up date saved');
      detail.reload();
    } catch (err) {
      setFollowUpError(errText(err));
      toast.error('Could not save the follow-up', errText(err));
    } finally {
      setSavingFollowUp(false);
    }
  };

  const completeTask = async (task: any) => {
    setCompletingId(task.id);
    try {
      await post(`/tasks/${task.id}/complete`, {});
      toast.success('Task completed');
      detail.reload();
    } catch (err) {
      toast.error('Could not complete the task', errText(err));
    } finally {
      setCompletingId(null);
    }
  };

  const archive = async () => {
    setArchiving(true);
    try {
      await post(`/prospects/${id}/archive`);
      toast.success('Prospect archived');
      navigate('/prospecting');
    } catch (err) {
      setShowArchive(false);
      toast.error('Could not archive this prospect', errText(err));
    } finally {
      setArchiving(false);
    }
  };

  if (detail.error && !detail.data) {
    return (
      <>
        <PageHead title="Prospect" actions={<LinkButton to="/prospecting">Back to Prospecting</LinkButton>} />
        <ErrorState error={detail.error} onRetry={detail.reload} />
      </>
    );
  }
  if (!detail.data) {
    return <Loading label="Loading prospect…" />;
  }
  if (!row) {
    return (
      <>
        <PageHead title="Prospect" actions={<LinkButton to="/prospecting">Back to Prospecting</LinkButton>} />
        <EmptyState title="Prospect not found" icon={<Icon name="alert" size={22} />}>
          It may have been archived or the link is out of date.
        </EmptyState>
      </>
    );
  }

  const name = `${row.contact_first ?? ''} ${row.contact_last ?? ''}`.trim() || '—';
  const tasks = detail.data.tasks ?? [];
  const communications = detail.data.communications ?? [];
  const documents = detail.data.documents ?? [];
  const opportunity = detail.data.opportunity ?? null;

  const timingLabel = row.timing
    ? (config.data?.timingBuckets ?? []).find((b: any) => b.key === row.timing)?.name ??
      titleCase(row.timing)
    : '—';
  const tempLabel = row.temperature
    ? TEMPERATURE_LABELS[row.temperature] ?? titleCase(row.temperature)
    : '—';

  const contact = {
    id: row.contact_id,
    first_name: row.contact_first,
    last_name: row.contact_last,
    phone: row.phone,
    mobile: row.mobile,
    email: row.email,
    consent_sms: row.consent_sms,
    consent_email: row.consent_email,
    opt_out_at: row.opt_out_at,
  };

  const tabBody: ReactNode = (() => {
    if (tab === 'communications') {
      return (
        <CommunicationPanel
          contactId={row.contact_id}
          contact={contact}
          history={communications}
          prospectId={id}
          onChanged={detail.reload}
        />
      );
    }
    if (tab === 'documents') {
      return documents.length === 0 ? (
        <EmptyState title="No documents on this prospect" icon={<Icon name="file" size={22} />}>
          Documents attach from bids and contracts once this prospect is handed to
          Underwriting — there is no upload here yet.
        </EmptyState>
      ) : (
        <div className="list">
          {documents.map((d: any) => (
            <div className="list-item row" key={d.id}>
              <Icon name="file" size={15} />
              <span className="grow truncate" title={d.filename ?? ''}>
                {d.filename ?? '—'}
              </span>
              <span className="tiny muted">{d.kind ? titleCase(d.kind) : '—'}</span>
              <span className="tiny muted nowrap">{date(d.created_at)}</span>
            </div>
          ))}
        </div>
      );
    }
    if (tab === 'opportunity') {
      return opportunity ? (
        <Card title={opportunity.name ?? 'Opportunity'}>
          <KeyValue
            items={[
              ['Stage', opportunity.stage ? stageLabel(opportunity.stage) : '—'],
              [
                'Trade',
                opportunity.trade
                  ? TRADE_LABELS[opportunity.trade] ?? titleCase(opportunity.trade)
                  : '—',
              ],
              ['Scope', opportunity.scope_summary || '—'],
              ['Address', opportunity.project_address || '—'],
              ['Created', date(opportunity.created_at)],
              ['Updated', date(opportunity.updated_at)],
            ]}
          />
        </Card>
      ) : (
        <EmptyState title="No opportunity yet" icon={<Icon name="sales" size={22} />}>
          An opportunity is created with the prospect and follows it through every workspace.
        </EmptyState>
      );
    }
    return tasks.length === 0 ? (
      <EmptyState
        title="No tasks yet"
        icon={<Icon name="tasks" size={22} />}
        action={
          canTask ? (
            <Button variant="primary" onClick={() => setShowNewTask(true)}>
              New task
            </Button>
          ) : undefined
        }
      >
        Schedule the next call, site visit or document chase so this prospect never goes quiet.
      </EmptyState>
    ) : (
      <div className="stack" style={{ gap: 10 }}>
        <div className="row">
          <span className="small muted">{tasks.length} task(s)</span>
          <span className="spacer" />
          <Button
            size="sm"
            variant="primary"
            disabled={!canTask}
            title={canTask ? undefined : 'You do not have permission to manage tasks.'}
            icon={<Icon name="plus" size={14} />}
            onClick={() => setShowNewTask(true)}
          >
            New task
          </Button>
        </div>
        <div className="list">
          {tasks.map((t: any) => {
            const open = t.status === 'open';
            const overdue = open && t.due_at != null && Number(t.due_at) < Date.now();
            return (
              <div className="list-item row wrap" key={t.id}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row wrap">
                    <b className="truncate" title={t.title ?? ''}>
                      {t.title ?? '—'}
                    </b>
                    <Badge tone="outline">{t.type ? titleCase(t.type) : '—'}</Badge>
                    {open ? (
                      <Badge tone={overdue ? 'red' : 'blue'}>{overdue ? 'Overdue' : 'Open'}</Badge>
                    ) : t.status === 'done' ? (
                      <Badge tone="green">Done</Badge>
                    ) : (
                      <Badge tone="neutral">{t.status ? titleCase(t.status) : '—'}</Badge>
                    )}
                  </div>
                  <div className="tiny muted">
                    Due {dateTime(t.due_at)} · {t.assignee_name ?? 'Unassigned'}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={!canTask || !open}
                  loading={completingId === t.id}
                  title={canTask ? undefined : 'You do not have permission to manage tasks.'}
                  onClick={() => completeTask(t)}
                >
                  Complete
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    );
  })();

  return (
    <>
      <PageHead
        title={name}
        sub={row.company_name ?? '—'}
        actions={
          <>
            <LinkButton to="/prospecting" size="sm">
              Back to Prospecting
            </LinkButton>
            <Button
              size="sm"
              disabled={!canWrite}
              title={canWrite ? undefined : 'You do not have permission to edit prospects.'}
              onClick={() => setShowEdit(true)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!canWrite}
              title={canWrite ? undefined : 'You do not have permission to archive prospects.'}
              onClick={() => setShowArchive(true)}
            >
              Archive
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canHandoff}
              title={canHandoff ? undefined : 'You do not have permission to hand off prospects.'}
              onClick={() => setShowHandoff(true)}
            >
              Hand off to Underwriting
            </Button>
          </>
        }
      >
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <Badge tone="blue">{row.stage ? stageLabel(row.stage) : '—'}</Badge>
          <span className="row" style={{ gap: 5 }}>
            <TemperatureDot value={row.temperature ?? ''} />
            <span className="small">{tempLabel}</span>
          </span>
          <Badge tone={row.disposition_name ? 'violet' : 'outline'}>
            {row.disposition_name ?? 'No disposition'}
          </Badge>
          <span className="small muted">Owner: {row.owner_name ?? '—'}</span>
          {row.handoff_at ? <Badge tone="accent">Handed off {date(row.handoff_at)}</Badge> : null}
        </div>
      </PageHead>

      {/* A failed refresh keeps the record on screen — never hide the failure. */}
      {detail.error && detail.data ? <ErrorState error={detail.error} onRetry={detail.reload} /> : null}
      {config.error || roster.error ? (
        <ErrorState
          error={config.error ?? roster.error}
          onRetry={() => {
            if (config.error) config.reload();
            if (roster.error) roster.reload();
          }}
        />
      ) : null}

      <div className="split">
        <div className="stack">
          <Card title="Underwriting readiness" sub="Every required item must pass before a handoff.">
            {qual.loading && !qual.data ? (
              <Loading label="Checking readiness…" />
            ) : qual.error && !qual.data ? (
              <ErrorState error={qual.error} onRetry={qual.reload} />
            ) : qual.data ? (
              <div className="stack" style={{ gap: 10 }}>
                {qual.data.ok ? (
                  <Callout tone="green">
                    <b>Ready for Underwriting</b> — every required check passes.
                  </Callout>
                ) : (
                  <Callout tone="blue">
                    Close the items marked ✕ before handing this prospect off.
                  </Callout>
                )}
                <BlockerList
                  items={(qual.data.items ?? []).map((i) => ({
                    label: i.label || i.key || 'Check',
                    detail: i.hint,
                    passed: !!i.met,
                  }))}
                />
                {qual.data.existingBid ? (
                  <Callout tone="grey">
                    Already handed off as <b>{qual.data.existingBid.bid_no ?? 'a bid'}</b>.
                  </Callout>
                ) : null}
              </div>
            ) : null}
          </Card>

          <div>
            <Tabs
              tabs={[
                { key: 'tasks', label: 'Tasks', count: tasks.length },
                { key: 'communications', label: 'Communications', count: communications.length },
                { key: 'documents', label: 'Documents', count: documents.length },
                { key: 'opportunity', label: 'Opportunity' },
              ]}
              active={tab}
              onChange={setTab}
            />
            {tabBody}
          </div>
        </div>

        <div className="stack">
          <Card
            title="Contact"
            actions={
              <Button size="sm" onClick={() => setShowCard(true)} icon={<Icon name="contacts" size={14} />}>
                Contact card
              </Button>
            }
          >
            <KeyValue
              items={[
                ['Phone', row.phone || '—'],
                ['Mobile', row.mobile || '—'],
                ['Email', row.email ? <a href={`mailto:${row.email}`}>{row.email}</a> : '—'],
                ['Decision-maker', row.is_decision_maker === 1 ? 'Yes' : 'No'],
                [
                  'SMS consent',
                  row.consent_sms === 1 ? 'Granted' : row.consent_sms === 0 ? 'Not granted' : '—',
                ],
              ]}
            />
            {row.opt_out_at ? (
              <div className="warn-state" style={{ marginTop: 8 }}>
                Opted out of SMS on {date(row.opt_out_at)}.
              </div>
            ) : null}
          </Card>

          <Card title="Quick facts">
            <KeyValue
              items={[
                ['Source', row.source_name ?? '—'],
                ['Territory', row.territory_name ?? '—'],
                ['Timing', timingLabel],
                ['Company', row.company_name ?? '—'],
                ['Created', date(row.created_at)],
                ['Last contact', rel(row.last_contact_at)],
              ]}
            />
            <div className="divider" />
            <div className="field">
              <label htmlFor="follow-up-date">Next follow-up</label>
              <div className="row">
                <Input
                  id="follow-up-date"
                  type="date"
                  value={followUp}
                  disabled={!canWrite || savingFollowUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={savingFollowUp}
                  disabled={!canWrite}
                  title={canWrite ? undefined : 'You do not have permission to edit prospects.'}
                  onClick={saveFollowUp}
                >
                  Save
                </Button>
              </div>
              {followUpError ? (
                <div className="error-state" role="alert">
                  {followUpError}
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      {showCard ? (
        <Drawer
          title={name}
          sub={row.company_name ?? undefined}
          onClose={() => setShowCard(false)}
        >
          <ContactCard contactId={row.contact_id} onClosed={() => setShowCard(false)} />
        </Drawer>
      ) : null}

      {showNewTask ? (
        <NewTaskModal
          prospectId={id}
          contactId={row.contact_id}
          roster={roster.data?.rows ?? []}
          onClose={() => setShowNewTask(false)}
          onDone={() => {
            setShowNewTask(false);
            detail.reload();
          }}
        />
      ) : null}

      {showEdit ? (
        <EditProspectModal
          id={id}
          row={row}
          config={config.data}
          roster={roster.data?.rows ?? []}
          onClose={() => setShowEdit(false)}
          onDone={() => {
            setShowEdit(false);
            detail.reload();
            qual.reload();
          }}
        />
      ) : null}

      {showHandoff ? (
        <HandoffModal
          id={id}
          row={row}
          config={config.data}
          roster={roster.data?.rows ?? []}
          onClose={() => setShowHandoff(false)}
          onDone={() => {
            setShowHandoff(false);
            detail.reload();
            qual.reload();
          }}
        />
      ) : null}

      {showArchive ? (
        <ConfirmDialog
          title="Archive prospect"
          message={
            <>
              Archive <b>{name}</b>? It disappears from the board and the table. Tasks,
              communications and the audit trail are kept.
            </>
          }
          confirmLabel="Archive prospect"
          loading={archiving}
          onConfirm={archive}
          onCancel={() => setShowArchive(false)}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* New task                                                            */
/* ------------------------------------------------------------------ */

const TASK_FORM_ID = 'prospect-new-task-form';

function NewTaskModal({
  prospectId,
  contactId,
  roster,
  onClose,
  onDone,
}: {
  prospectId: string;
  contactId?: string;
  roster: RosterRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [type, setType] = useState('follow_up');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');

  const action = useAction(() =>
    post('/tasks', {
      title: title.trim(),
      notes: notes.trim(),
      type,
      assigneeId,
      dueAt: fromLocalInputValue(dueAt),
      prospectId,
      contactId: contactId || undefined,
    }),
  );

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    // The footer button sits outside the <form>, so validity is enforced here too.
    const form = document.getElementById(TASK_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const res = await action.run();
    if (res) {
      toast.success('Task created');
      onDone();
    }
    // Failures stay in the dialog: action.error.message is rendered above the fields.
  };

  return (
    <Modal
      title="New task"
      sub="Attached to this prospect and visible on the calendar."
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={action.pending} onClick={submit}>
            Create task
          </Button>
        </>
      }
    >
      <form id={TASK_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create task
        </button>
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Input
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call back about the roof scope"
        />
        <Select
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={TASK_TYPES.map(([value, label]) => ({ value, label }))}
        />
        <Select
          label="Assignee"
          required
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          placeholder="Select a person"
          options={roster.map((r) => ({ value: r.id, label: r.name }))}
        />
        <Input
          label="Due"
          required
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />
        <TextArea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Context the assignee needs before the call."
        />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

const EDIT_FORM_ID = 'prospect-edit-form';

function EditProspectModal({
  id,
  row,
  config,
  roster,
  onClose,
  onDone,
}: {
  id: string;
  row: any;
  config: ConfigData | null;
  roster: RosterRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [scopeSummary, setScopeSummary] = useState(row.scope_summary ?? '');
  const [projectAddress, setProjectAddress] = useState(row.project_address ?? '');
  const [stage, setStage] = useState(row.stage ?? 'prospect');
  const [temperature, setTemperature] = useState(row.temperature ?? 'warm');
  const [timing, setTiming] = useState(row.timing ?? 'within_month');
  const [dispositionId, setDispositionId] = useState(row.disposition_id ?? '');
  const [sourceId, setSourceId] = useState(row.source_id ?? '');
  const [territoryId, setTerritoryId] = useState(row.territory_id ?? '');
  const [ownerId, setOwnerId] = useState(row.owner_id ?? '');

  const dispositions = (config?.dispositions ?? []).filter(
    (d: any) => d.workspace === 'prospect' && d.active === 1,
  );

  const action = useAction(() =>
    patch(`/prospects/${id}`, {
      scopeSummary,
      projectAddress,
      stage,
      temperature,
      timing,
      dispositionId: dispositionId || null,
      sourceId: sourceId || null,
      territoryId: territoryId || null,
      ownerId: ownerId || null,
    }),
  );

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    // The footer button sits outside the <form>, so validity is enforced here too.
    const form = document.getElementById(EDIT_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const res = await action.run();
    if (res) {
      toast.success('Prospect updated');
      onDone();
    }
  };

  return (
    <Modal
      title="Edit prospect"
      sub={row.contact_first || row.contact_last ? `${row.contact_first ?? ''} ${row.contact_last ?? ''}`.trim() : id}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={action.pending} onClick={submit}>
            Save changes
          </Button>
        </>
      }
    >
      <form id={EDIT_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Save changes
        </button>
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <TextArea
          label="Scope of work"
          required
          value={scopeSummary}
          onChange={(e) => setScopeSummary(e.target.value)}
        />
        <Input
          label="Project address"
          required
          value={projectAddress}
          onChange={(e) => setProjectAddress(e.target.value)}
        />
        <div className="form-grid">
          <Select
            label="Stage"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            options={[
              { value: 'prospect', label: 'Prospect' },
              { value: 'lead', label: 'Lead' },
              { value: 'nurturing', label: 'Nurturing' },
            ]}
          />
          <Select
            label="Temperature"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            options={['hot', 'warm', 'cold'].map((t) => ({
              value: t,
              label: TEMPERATURE_LABELS[t] ?? titleCase(t),
            }))}
          />
          <Select
            label="Timing"
            value={timing}
            onChange={(e) => setTiming(e.target.value)}
            options={(config?.timingBuckets ?? []).map((b: any) => ({ value: b.key, label: b.name }))}
          />
          <Select
            label="Disposition"
            value={dispositionId}
            onChange={(e) => setDispositionId(e.target.value)}
            placeholder="Unset"
            options={dispositions.map((d: any) => ({ value: d.id, label: d.name }))}
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
            label="Owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            placeholder="Unset"
            options={roster.map((r) => ({ value: r.id, label: r.name }))}
          />
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Hand-off to Underwriting (with the live qualification checklist)    */
/* ------------------------------------------------------------------ */

const HANDOFF_FORM_ID = 'prospect-handoff-form';

function HandoffModal({
  id,
  row,
  config,
  roster,
  onClose,
  onDone,
}: {
  id: string;
  row: any;
  config: ConfigData | null;
  roster: RosterRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const qual = useFetch<QualData>(`/prospects/${id}/qualification`, [id]);
  const [trade, setTrade] = useState('');
  const [estimatorId, setEstimatorId] = useState('');
  const [quoteDue, setQuoteDue] = useState('');
  const [takeoffRequired, setTakeoffRequired] = useState(false);
  const [performMode, setPerformMode] = useState('self');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // 422 carries the blocker list; the dialog stays open until the gaps are closed.
  const blockers =
    error && error.status === 422
      ? (error.blockers ?? []).map((b: any) =>
          typeof b === 'string' ? { label: b } : { label: b?.label ?? 'Blocked', detail: b?.detail },
        )
      : [];

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    // The footer button sits outside the <form>, so validity is enforced here too.
    const form = document.getElementById(HANDOFF_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await post<any>(`/prospects/${id}/handoff`, {
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
        qual.reload();
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
      sub="Creates the bid and moves the opportunity to Underwriting."
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
      <form id={HANDOFF_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create bid
        </button>
        <div className="stack" style={{ gap: 8 }}>
          {qual.loading && !qual.data ? (
            <Loading label="Checking readiness…" />
          ) : qual.error && !qual.data ? (
            <ErrorState error={qual.error} onRetry={qual.reload} />
          ) : qual.data ? (
            <>
              {qual.data.ok ? (
                <Callout tone="green">
                  <b>Ready for Underwriting</b> — every required check passes.
                </Callout>
              ) : (
                <Callout tone="red">
                  This prospect is not ready yet — clear the ✕ items below.
                </Callout>
              )}
              <BlockerList
                items={(qual.data.items ?? []).map((i) => ({
                  label: i.label || i.key || 'Check',
                  detail: i.hint,
                  passed: !!i.met,
                }))}
              />
            </>
          ) : null}
        </div>

        {error ? (
          <div className={error.status === 422 ? 'warn-state' : 'error-state'} role="alert">
            {error.message}
          </div>
        ) : null}
        {blockers.length ? <BlockerList items={blockers} /> : null}

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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={takeoffRequired}
            onChange={(e) => setTakeoffRequired(e.target.checked)}
          />
          <span>Takeoff required</span>
        </label>
      </form>
    </Modal>
  );
}
