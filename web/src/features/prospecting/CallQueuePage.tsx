import { useState, type ReactNode } from 'react';
import { post, ApiError } from '../../lib/api';
import { useFetch, useAction } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  PageHead,
  Select,
  Stat,
  Tabs,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateTime, rel, titleCase } from '../../lib/format';

type Bucket = 'overdue' | 'dueToday' | 'callbacks' | 'other';

const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'dueToday', label: 'Due today' },
  { key: 'callbacks', label: 'Callbacks' },
  { key: 'other', label: 'Other' },
];

const CALL_OUTCOMES = [
  ['connected', 'Connected'],
  ['no_answer', 'No answer'],
  ['voicemail', 'Left voicemail'],
  ['callback_requested', 'Callback requested'],
  ['not_interested', 'Not interested'],
  ['wrong_number', 'Wrong number'],
] as const;

const DAY_MS = 86_400_000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

interface QRow {
  id: string;
  contact_id: string;
  [key: string]: any;
}

/** `priority_bucket` is the server's own lane (1..4) when it sends one. */
const BY_PRIORITY: Record<number, Bucket> = { 1: 'overdue', 2: 'dueToday', 3: 'callbacks', 4: 'other' };

/**
 * Client-side bucket rule, mirroring the server's counts:
 * due before today's local midnight = overdue; the same calendar day = dueToday;
 * scheduled after today ends (type 'callback' or not) = callbacks;
 * no usable due_at at all = other. Every lookup falls back with `??` because
 * call-queue metadata is allowed to arrive incomplete.
 */
function bucketOf(row: any): Bucket {
  const fromServer = BY_PRIORITY[row?.priority_bucket ?? -1];
  if (fromServer) return fromServer;
  const due = row?.due_at ?? null;
  if (due == null) return 'other';
  const today = startOfToday();
  if (Number(due) < today) return 'overdue';
  if (Number(due) < today + DAY_MS) return 'dueToday';
  return 'callbacks';
}

export default function CallQueuePage() {
  const toast = useToast();
  const { can } = useAuth();
  const [bucket, setBucket] = useState<Bucket>('overdue');
  const [logTarget, setLogTarget] = useState<QRow | null>(null);
  const [textPendingId, setTextPendingId] = useState<string | null>(null);
  const queue = useFetch<{ rows: QRow[]; counts: Record<string, number> }>('/tasks/call-queue');
  const canLog = can('comms.log');

  const rows = queue.data?.rows ?? [];
  const parts: Record<Bucket, QRow[]> = { overdue: [], dueToday: [], callbacks: [], other: [] };
  for (const r of rows) parts[bucketOf(r)].push(r);
  const active = parts[bucket];
  const counts = queue.data?.counts;

  const queueNoAnswerText = async (row: QRow) => {
    setTextPendingId(row.id);
    try {
      const res = await post<any>('/communications/no-answer-text', {
        contactId: row.contact_id,
        prospectId: row.prospect_id ?? undefined,
        attempt: 1,
      });
      // The server reports draft when no SMS provider is configured — never claim delivery then.
      if ((res?.delivery?.status ?? 'draft') === 'draft') {
        toast.success(
          'Draft recorded — nothing was delivered',
          'Test mode: history and the next callback task were saved.',
        );
      } else {
        toast.success('Text queued for delivery');
      }
      queue.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Duplicate prevented', err.message);
      } else {
        toast.error('Could not queue the text', err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setTextPendingId(null);
    }
  };

  let body: ReactNode;
  if (queue.error && !queue.data) {
    body = <ErrorState error={queue.error} onRetry={queue.reload} />;
  } else if (queue.loading && !queue.data) {
    body = <Loading label="Loading call queue…" />;
  } else if (active.length === 0) {
    const copy: Record<Bucket, string> = {
      overdue: 'Nothing is past due. Every follow-up is still ahead of schedule.',
      dueToday: 'Nothing is due today.',
      callbacks: 'No promised callbacks are waiting.',
      other: 'No other call tasks are waiting.',
    };
    body = (
      <EmptyState title={`Nothing in “${BUCKETS.find((b) => b.key === bucket)?.label}”`} icon={<Icon name="phone" size={22} />}>
        {copy[bucket]}
      </EmptyState>
    );
  } else {
    body = (
      <div className="grid grid-2">
        {active.map((row) => {
          const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || '—';
          const phone = row.phone || row.mobile || '';
          const attempts = row.call_attempts ?? row.prior_call_attempts ?? row.call_attempt_count ?? null;
          const lastAttempt =
            row.last_attempt_summary ?? row.last_communication_summary ?? null;
          const due = row.due_at ?? null;
          const overdue = due != null && Number(due) < startOfToday();
          return (
            <div className="card card-pad" key={row.id}>
              <div className="col" style={{ gap: 6 }}>
                <div className="row wrap">
                  <b className="grow truncate" title={name}>
                    {name}
                  </b>
                  {row.is_decision_maker === 1 ? <Badge tone="accent">Decision-maker</Badge> : null}
                  {row.consent_sms === 1 ? (
                    <Badge tone="green">SMS consent</Badge>
                  ) : row.consent_sms === 0 ? (
                    <Badge tone="amber">No SMS consent</Badge>
                  ) : null}
                  <span className="spacer" />
                  <span
                    className="tiny"
                    style={overdue ? { color: 'var(--red)', fontWeight: 600 } : { color: 'var(--muted)' }}
                  >
                    {due == null
                      ? '—'
                      : overdue
                        ? `overdue · ${rel(due)}`
                        : `due ${rel(due)}`}
                  </span>
                </div>

                <div className="small muted truncate">{row.company_name ?? '—'}</div>
                {row.title ? (
                  <div className="tiny muted truncate" title={row.title}>
                    Task: {row.title}
                  </div>
                ) : null}
                {row.type ? <Badge tone="outline">{titleCase(row.type)}</Badge> : null}

                <div className="row wrap">
                  {phone ? (
                    <>
                      <a className="btn btn-sm" href={`tel:${phone}`}>
                        <Icon name="phone" size={14} /> Call
                      </a>
                      <span className="small mono">{phone}</span>
                    </>
                  ) : (
                    <span className="small muted">—</span>
                  )}
                </div>

                <div className="tiny muted">
                  {attempts != null
                    ? `${attempts} prior call attempt${Number(attempts) === 1 ? '' : 's'}`
                    : '—'}
                </div>
                {lastAttempt ? (
                  <div className="tiny muted truncate" title={String(lastAttempt)}>
                    Last attempt: {String(lastAttempt)}
                  </div>
                ) : null}
                {row.due_at ? <div className="tiny muted">Queued {dateTime(row.due_at)}</div> : null}

                <div className="row wrap" style={{ marginTop: 4 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!canLog}
                    title={canLog ? undefined : 'You do not have permission to log communications.'}
                    icon={<Icon name="phone" size={14} />}
                    onClick={() => setLogTarget(row)}
                  >
                    Log call
                  </Button>
                  <Button
                    size="sm"
                    disabled={!canLog || row.consent_sms !== 1 || textPendingId === row.id}
                    loading={textPendingId === row.id}
                    title={
                      !canLog
                        ? 'You do not have permission to log communications.'
                        : row.consent_sms === 1
                          ? undefined
                          : 'This contact has no SMS consent on file.'
                    }
                    icon={<Icon name="message" size={14} />}
                    onClick={() => queueNoAnswerText(row)}
                  >
                    Queue no-answer text
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <PageHead
        title="Call Queue"
        sub="Phone-first order of work: overdue first, then due today, then promised callbacks, then everything else. Work top down."
        actions={
          <Button size="sm" disabled={queue.loading} onClick={queue.reload}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Overdue" value={counts?.overdue ?? '—'} tone="bad" detail="past their due time" />
        <Stat label="Due today" value={counts?.dueToday ?? '—'} tone="accent" detail="before midnight" />
        <Stat label="Callbacks" value={counts?.callbacks ?? '—'} tone="info" detail="due after today" />
        <Stat label="Other" value={counts?.other ?? '—'} detail="no due date" />
      </div>

      <Tabs
        tabs={BUCKETS.map((b) => ({ key: b.key, label: b.label, count: parts[b.key].length }))}
        active={bucket}
        onChange={(k) => setBucket(k as Bucket)}
      />

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {queue.error && queue.data ? <ErrorState error={queue.error} onRetry={queue.reload} /> : null}

      {body}

      {logTarget ? (
        <LogCallModal
          row={logTarget}
          onClose={() => setLogTarget(null)}
          onDone={() => {
            setLogTarget(null);
            queue.reload();
          }}
        />
      ) : null}
    </>
  );
}

function LogCallModal({ row, onClose, onDone }: { row: QRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<string>('connected');
  const [notes, setNotes] = useState('');

  const action = useAction(() =>
    post('/communications/call', {
      contactId: row.contact_id,
      prospectId: row.prospect_id ?? undefined,
      outcome,
      notes: notes.trim(),
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res) {
      toast.success('Call logged');
      onDone();
    }
    // Otherwise action.error.message is rendered inside the dialog.
  };

  return (
    <Modal
      title="Log call"
      sub={`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.contact_id}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={action.pending} onClick={submit}>
            Save call
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
          label="Outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          options={CALL_OUTCOMES.map(([value, label]) => ({ value, label }))}
        />
        <TextArea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was discussed and what happens next."
        />
      </div>
    </Modal>
  );
}
