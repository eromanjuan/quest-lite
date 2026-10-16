import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { del, post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  PageHead,
  Segmented,
  Select,
  Stat,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateTime, fromLocalInputValue, titleCase, toLocalInputValue } from '../../lib/format';

interface TaskRow {
  id: string;
  title: string;
  notes?: string | null;
  type?: string | null;
  status: string;
  due_at?: number | null;
  priority?: number | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  contact_id?: string | null;
  prospect_id?: string | null;
  bid_id?: string | null;
  deal_id?: string | null;
  project_id?: string | null;
  job_id?: string | null;
  [key: string]: any;
}

interface RosterRow {
  id: string;
  name: string;
  email?: string;
  role_key?: string;
  active?: number;
}

interface Envelope<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

type StatusFilter = 'open' | 'done' | 'all';

const PAGE_SIZE = 25;
const TASK_FORM_ID = 'records-new-task-form';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Filter list — unknown values still pass through to the server's own query. */
const FILTER_TYPES = ['call', 'follow_up', 'task', 'site_visit', 'review', 'other'];

/**
 * Creating posts `type` straight to the server, which validates it against its
 * own enum — so only values it accepts may be offered here.
 */
const CREATE_TYPES = ['follow_up', 'call', 'text', 'email', 'site_visit', 'document', 'task'];

const PRIORITY_OPTIONS = [
  { value: '0', label: 'Normal' },
  { value: '1', label: 'High' },
];

const LINK_FIELDS = ['contact_id', 'prospect_id', 'bid_id', 'deal_id', 'project_id', 'job_id'];

const DAY_MS = 86_400_000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** 1 = High (red), 2 = Medium (amber), anything else = Normal. */
function PriorityBadge({ value }: { value: number | null | undefined }) {
  if (value === 1) return <Badge tone="red">High</Badge>;
  if (value === 2) return <Badge tone="amber">Medium</Badge>;
  return <Badge tone="neutral">Normal</Badge>;
}

/** Whichever single foreign key is set, labelled by its record type. */
function linkedTo(row: TaskRow): string | null {
  for (const field of LINK_FIELDS) {
    if (row[field]) return titleCase(field.replace(/_id$/, ''));
  }
  return null;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'done') return <Badge tone="green">Done</Badge>;
  if (status === 'cancelled') return <Badge tone="neutral">Cancelled</Badge>;
  return null;
}

export default function TasksPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canWrite = can('task.write');

  const [status, setStatus] = useState<StatusFilter>('open');
  const [assignee, setAssignee] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);

  const [showNew, setShowNew] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<TaskRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<TaskRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRow | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');
  const rosterRows = roster.data?.rows ?? [];

  // Date inputs hand back "YYYY-MM-DD": pin the start to local midnight and the
  // end to the last millisecond of the same day so the whole day is included.
  const fromMs = from ? fromLocalInputValue(`${from}T00:00`) : null;
  const toStart = to ? fromLocalInputValue(`${to}T00:00`) : null;
  const toMs = toStart == null ? null : toStart + DAY_MS - 1;

  // Any filter change starts the result set over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [status, assignee, type, dq, from, to]);

  const path = `/tasks${qs({
    status,
    assignee,
    type,
    q: dq,
    from: fromMs,
    to: toMs,
    limit: PAGE_SIZE,
    offset,
  })}`;
  const list = useFetch<Envelope<TaskRow>>(path, [path]);

  const rows = list.data?.rows ?? [];
  const limit = list.data?.limit ?? PAGE_SIZE;
  const total = list.data?.total ?? 0;
  const hasMore = list.data?.hasMore ?? offset + rows.length < total;
  const active = !!(dq || assignee || type || from || to || status !== 'open');

  const now = Date.now();
  const todayStart = startOfToday();
  const todayEnd = todayStart + DAY_MS;

  const openRows = rows.filter((r) => r.status === 'open');
  const overdueCount = openRows.filter((r) => r.due_at != null && r.due_at < now).length;
  const dueTodayCount = openRows.filter(
    (r) => r.due_at != null && r.due_at >= todayStart && r.due_at < todayEnd,
  ).length;
  const highCount = openRows.filter((r) => r.priority === 1).length;

  const bucketOf = (r: TaskRow): 'overdue' | 'today' | 'later' | 'noDue' | 'closed' => {
    if (r.status !== 'open') return 'closed';
    const due = r.due_at ?? null;
    if (due == null) return 'noDue';
    if (due < now) return 'overdue';
    if (due < todayEnd) return 'today';
    return 'later';
  };

  const buckets: Record<string, TaskRow[]> = {
    overdue: [],
    today: [],
    later: [],
    noDue: [],
    closed: [],
  };
  for (const r of rows) buckets[bucketOf(r)].push(r);

  const reload = () => list.reload();

  const cancelTask = async (task: TaskRow) => {
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await post(`/tasks/${task.id}/cancel`, {});
      toast.success('Task cancelled', task.title);
      setCancelTarget(null);
      reload();
    } catch (err) {
      setConfirmError(errText(err));
    } finally {
      setConfirmBusy(false);
    }
  };

  const deleteTask = async (task: TaskRow) => {
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await del(`/tasks/${task.id}`);
      toast.success('Task deleted', task.title);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      // 409: completed tasks cannot be deleted — the server's own words go up.
      const message = errText(err);
      setConfirmError(message);
      if (err instanceof ApiError && err.status === 409) toast.error('Could not delete task', message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const reopenTask = async (task: TaskRow) => {
    try {
      await post(`/tasks/${task.id}/reopen`, {});
      toast.success('Task reopened', task.title);
      reload();
    } catch (err) {
      toast.error('Could not reopen task', errText(err));
    }
  };

  const tableFor = (listRows: TaskRow[]) => (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Task</th>
            <th>Type</th>
            <th>Priority</th>
            <th>Due</th>
            <th>Assignee</th>
            <th>Linked to</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {listRows.map((r) => {
            const due = r.due_at ?? null;
            const overdue = r.status === 'open' && due != null && due < now;
            const linked = linkedTo(r);
            return (
              <tr key={r.id}>
                <td>
                  <div className="strong truncate" style={{ maxWidth: 320 }} title={r.title}>
                    {r.title}
                  </div>
                  <div className="small muted truncate" style={{ maxWidth: 320 }} title={r.notes ?? ''}>
                    {r.notes || '—'}
                  </div>
                </td>
                <td className="nowrap">
                  <Badge tone="outline">{r.type ? titleCase(r.type) : '—'}</Badge>{' '}
                  <StatusBadge status={r.status} />
                </td>
                <td className="nowrap">
                  <PriorityBadge value={r.priority} />
                </td>
                <td className="nowrap">
                  {due == null ? (
                    '—'
                  ) : (
                    <span style={overdue ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
                      {dateTime(due)}
                    </span>
                  )}
                </td>
                <td className="nowrap">{r.assignee_name ?? '—'}</td>
                <td className="nowrap">{linked ? <Badge tone="violet">{linked}</Badge> : '—'}</td>
                <td>
                  <div className="row wrap">
                    {r.status === 'open' ? (
                      <>
                        <Button
                          size="sm"
                          variant="success"
                          disabled={!canWrite}
                          title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
                          onClick={() => setCompleteTarget(r)}
                        >
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          disabled={!canWrite}
                          title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
                          onClick={() => {
                            setConfirmError(null);
                            setCancelTarget(r);
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!canWrite}
                        title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
                        onClick={() => void reopenTask(r)}
                      >
                        Reopen
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!canWrite}
                      title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
                      onClick={() => {
                        setConfirmError(null);
                        setDeleteTarget(r);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  let body: ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading tasks…" />;
  } else if (rows.length === 0) {
    body = active ? (
      <EmptyState title="No tasks match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the filters to see the full list.
      </EmptyState>
    ) : (
      <EmptyState title="No tasks yet" icon={<Icon name="tasks" size={22} />}>
        Schedule the next action on any contact, deal or job and it will show up here.
      </EmptyState>
    );
  } else {
    const sections: Array<{ key: string; label: string; tone: 'red' | 'amber' | 'blue' | 'neutral' }> = [
      { key: 'overdue', label: 'Overdue', tone: 'red' },
      { key: 'today', label: 'Due today', tone: 'amber' },
      { key: 'later', label: 'Later', tone: 'blue' },
      { key: 'noDue', label: 'No due date', tone: 'neutral' },
      { key: 'closed', label: 'Completed / cancelled', tone: 'neutral' },
    ];
    body = (
      <>
        {sections
          .filter((s) => buckets[s.key].length > 0)
          .map((s) => (
            <section key={s.key} style={{ marginTop: 14 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <b>{s.label}</b>
                <Badge tone={s.tone}>{buckets[s.key].length}</Badge>
              </div>
              {tableFor(buckets[s.key])}
            </section>
          ))}

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
        title="Tasks"
        sub="Work the list in priority order: overdue first, then due today, then scheduled callbacks, then everything else."
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={!canWrite}
            title={canWrite ? undefined : 'You do not have permission to create tasks.'}
            icon={<Icon name="plus" size={14} />}
            onClick={() => setShowNew(true)}
          >
            New task
          </Button>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Overdue" value={overdueCount} tone="bad" detail="past due, still open" />
        <Stat label="Due today" value={dueTodayCount} tone="accent" detail="before midnight" />
        <Stat label="Open total" value={openRows.length} tone="info" detail="in this view" />
        <Stat label="High priority" value={highCount} detail="priority = 1" />
      </div>

      <div className="filters">
        <Segmented<StatusFilter>
          options={[
            { value: 'open', label: 'Open' },
            { value: 'done', label: 'Done' },
            { value: 'all', label: 'All' },
          ]}
          value={status}
          onChange={setStatus}
        />
        <Select
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          disabled={roster.loading && !roster.data}
          options={[
            { value: '', label: 'Anyone' },
            ...rosterRows.map((r) => ({ value: r.id, label: r.name })),
          ]}
        />
        <Select
          aria-label="Type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={[
            { value: '', label: 'Any type' },
            ...FILTER_TYPES.map((t) => ({ value: t, label: titleCase(t) })),
          ]}
        />
        <Input
          type="search"
          aria-label="Search tasks"
          placeholder="Search title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Due from"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Due to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      {roster.error ? <ErrorState error={roster.error} onRetry={roster.reload} /> : null}

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}

      {showNew ? (
        <NewTaskModal
          roster={rosterRows}
          onClose={() => setShowNew(false)}
          onDone={() => {
            setShowNew(false);
            reload();
          }}
        />
      ) : null}

      {completeTarget ? (
        <CompleteTaskModal
          task={completeTarget}
          onClose={() => setCompleteTarget(null)}
          onDone={() => {
            setCompleteTarget(null);
            reload();
          }}
        />
      ) : null}

      {cancelTarget ? (
        <ConfirmDialog
          title="Cancel task"
          message={`“${cancelTarget.title}” will be marked cancelled. It stays on record but leaves the open list.`}
          confirmLabel="Cancel task"
          loading={confirmBusy}
          onConfirm={() => void cancelTask(cancelTarget)}
          onCancel={() => setCancelTarget(null)}
        >
          {confirmError ? (
            <div className="error-state" role="alert">
              {confirmError}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete task"
          message="This permanently removes the task. Completed tasks cannot be deleted."
          confirmLabel="Delete task"
          loading={confirmBusy}
          onConfirm={() => void deleteTask(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        >
          {confirmError ? (
            <div className="error-state" role="alert">
              {confirmError}
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Completion note                                                     */
/* ------------------------------------------------------------------ */

function CompleteTaskModal({
  task,
  onClose,
  onDone,
}: {
  task: TaskRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await post(`/tasks/${task.id}/complete`, note.trim() ? { completionNote: note.trim() } : {});
      toast.success('Task completed', task.title);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Complete task"
      sub={task.title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="success" loading={pending} onClick={() => void submit()}>
            Mark complete
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="error-state" role="alert">
            {error}
          </div>
        ) : null}
        <TextArea
          label="Completion note"
          hint="Optional — what happened and what comes next."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* New task — also used by the calendar day sheet                      */
/* ------------------------------------------------------------------ */

const LINK_OPTIONS = [
  { value: '', label: 'Not linked' },
  { value: 'contact', label: 'Contact' },
  { value: 'deal', label: 'Deal' },
  { value: 'project', label: 'Project' },
  { value: 'job', label: 'Job' },
];

export function NewTaskModal({
  roster,
  defaultDueAt,
  onClose,
  onDone,
}: {
  roster: RosterRow[];
  defaultDueAt?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [type, setType] = useState('follow_up');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState(() => toLocalInputValue(defaultDueAt ?? Date.now() + 3_600_000));
  const [priority, setPriority] = useState('0');
  const [linkKind, setLinkKind] = useState('');
  const [contactId, setContactId] = useState('');
  const [idValue, setIdValue] = useState('');
  const [contactQ, setContactQ] = useState('');
  const contactDq = useDebounced(contactQ, 300);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; fieldErrors: Record<string, string> } | null>(null);

  // Contact picker only fetches once the user actually asks for a contact.
  const contactPath = linkKind === 'contact' ? `/contacts${qs({ q: contactDq, limit: 50 })}` : null;
  const contacts = useFetch<Envelope<{ id: string; first_name?: string; last_name?: string; company_name?: string | null }>>(
    contactPath,
    [contactPath],
  );

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const form = document.getElementById(TASK_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const dueMs = fromLocalInputValue(dueAt);
    if (dueMs == null) {
      setError({ message: 'Pick a due date and time.', fieldErrors: {} });
      return;
    }

    setPending(true);
    setError(null);
    const body: Record<string, unknown> = {
      title: title.trim(),
      notes: notes.trim(),
      type,
      assigneeId,
      dueAt: dueMs,
      priority: Number(priority),
    };
    // Links are honest: a contact is picked from the list, the rest are raw ids.
    if (linkKind === 'contact' && contactId) body.contactId = contactId;
    if (linkKind === 'deal' && idValue.trim()) body.dealId = idValue.trim();
    if (linkKind === 'project' && idValue.trim()) body.projectId = idValue.trim();
    if (linkKind === 'job' && idValue.trim()) body.jobId = idValue.trim();

    try {
      await post('/tasks', body);
      toast.success('Task created', title.trim());
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message, fieldErrors: err.fieldErrors });
      } else {
        setError({ message: errText(err), fieldErrors: {} });
      }
    } finally {
      setPending(false);
    }
  };

  const fe = error?.fieldErrors ?? {};

  return (
    <Modal
      title="New task"
      sub="Every task needs an owner and a due date."
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={pending} onClick={() => void submit()}>
            Create task
          </Button>
        </>
      }
    >
      <form id={TASK_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create task
        </button>
        {error ? (
          <div className="error-state" role="alert">
            {error.message}
          </div>
        ) : null}

        <Input
          label="Title"
          required
          value={title}
          error={fe.title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call back about the roof scope"
        />
        <TextArea
          label="Notes"
          value={notes}
          error={fe.notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <div className="form-grid">
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={CREATE_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
          />
          <Select
            label="Assignee"
            required
            value={assigneeId}
            error={fe.assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            placeholder="Select a person"
            options={roster.map((r) => ({ value: r.id, label: r.name }))}
          />
          <Input
            label="Due"
            type="datetime-local"
            required
            value={dueAt}
            error={fe.dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
          <Select
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            options={PRIORITY_OPTIONS}
          />
        </div>

        <div className="form-grid">
          <Select
            label="Link to"
            value={linkKind}
            onChange={(e) => {
              setLinkKind(e.target.value);
              setIdValue('');
              setContactId('');
            }}
            options={LINK_OPTIONS}
          />
          {linkKind === 'contact' ? (
            <>
              <Input
                type="search"
                aria-label="Search contacts"
                placeholder="Search contacts…"
                value={contactQ}
                onChange={(e) => setContactQ(e.target.value)}
              />
              <Select
                label="Contact"
                value={contactId}
                error={fe.contactId}
                onChange={(e) => setContactId(e.target.value)}
                placeholder={contacts.loading ? 'Loading contacts…' : 'Select a contact'}
                options={(contacts.data?.rows ?? []).map((c) => ({
                  value: c.id,
                  label: `${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()}${c.company_name ? ` — ${c.company_name}` : ''}`,
                }))}
              />
              {contacts.error ? <ErrorState error={contacts.error} onRetry={contacts.reload} /> : null}
            </>
          ) : null}
          {linkKind === 'deal' ? (
            <Input
              label="Deal id"
              value={idValue}
              onChange={(e) => setIdValue(e.target.value)}
              hint="Paste the id from the deal record."
            />
          ) : null}
          {linkKind === 'project' ? (
            <Input
              label="Project id"
              value={idValue}
              onChange={(e) => setIdValue(e.target.value)}
              hint="Paste the id from the project record."
            />
          ) : null}
          {linkKind === 'job' ? (
            <Input
              label="Job id"
              value={idValue}
              onChange={(e) => setIdValue(e.target.value)}
              hint="Paste the id from the job record."
            />
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
