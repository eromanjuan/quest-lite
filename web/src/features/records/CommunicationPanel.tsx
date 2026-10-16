import { useMemo, useState } from 'react';
import { get, post, ApiError } from '../../lib/api';
import { useFetch, useAction } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Card,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateTime, rel, titleCase, renderTemplate, money } from '../../lib/format';

const CALL_OUTCOMES = [
  ['connected', 'Connected'],
  ['no_answer', 'No answer'],
  ['voicemail', 'Left voicemail'],
  ['callback_requested', 'Callback requested'],
  ['not_interested', 'Not interested'],
  ['wrong_number', 'Wrong number'],
] as const;

const CHANNEL_TONES: Record<string, string> = {
  call: 'blue',
  text: 'violet',
  email: 'accent',
  note: 'neutral',
  meeting: 'green',
};

interface ContactLite {
  id: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  consent_sms?: number;
  consent_email?: number;
  opt_out_at?: number | null;
}

/**
 * Communication hub: history, call logging, and the no-answer text automation.
 *
 * The provider status at the top of this panel is read from the server's
 * integration endpoint — nothing here ever claims a message was "sent" when
 * the app is in test mode.
 */
export function CommunicationPanel({
  contactId,
  contact,
  history,
  onChanged,
  prospectId,
}: {
  contactId: string;
  contact: ContactLite;
  history: any[];
  onChanged: () => void;
  prospectId?: string;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [showLog, setShowLog] = useState(false);
  const [showText, setShowText] = useState(false);

  const integrations = useFetch<{
    sms: { provider: string; configured: boolean; forceTestMode: boolean };
    email: { provider: string; configured: boolean; forceTestMode: boolean };
  }>('/admin/integrations');

  // Live only when a provider is configured AND test mode is off. The `?? false`
  // matters: before integrations load this must read as "not live", never as
  // "maybe live" — the UI claims delivery only when the server can deliver.
  const liveSms = (integrations.data?.sms.configured && !integrations.data.sms.forceTestMode) ?? false;

  return (
    <div className="stack">
      <Callout tone={liveSms ? 'green' : 'grey'}>
        {liveSms ? (
          <>
            SMS delivery is <strong>live</strong> via {integrations.data?.sms.provider}. Messages
            are actually delivered to the recipient.
          </>
        ) : (
          <>
            SMS is in <strong>test mode</strong>. The no-answer text flow records a draft with full
            history and the next callback task, but nothing is delivered to the customer until an
            SMS provider and API key are configured. See <code>docs/integrations.md</code>.
          </>
        )}
      </Callout>

      <div className="row wrap">
        <Button variant="primary" size="sm" onClick={() => setShowLog(true)}>
          <Icon name="phone" size={14} /> Log a call
        </Button>
        <Button
          size="sm"
          onClick={() => setShowText(true)}
          disabled={!contact.phone && !contact.mobile}
          title={!contact.phone && !contact.mobile ? 'This contact has no phone number on file.' : undefined}
        >
          <Icon name="message" size={14} /> No-answer text
        </Button>
        <span className="spacer" />
        <span className="small muted">{history.length} logged</span>
      </div>

      {history.length === 0 ? (
        <EmptyState title="No communications yet" icon={<span>☎</span>}>
          Log the first call to start building the contact timeline. Every entry is auditable.
        </EmptyState>
      ) : (
        <Card title="History" flush>
          <div className="list">
            {history.map((h) => (
              <div
                className="list-item"
                key={h.id}
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 5 }}
              >
                <div className="row wrap">
                  <Badge tone={(CHANNEL_TONES[h.channel] as any) ?? 'neutral'}>
                    {titleCase(h.channel)}
                  </Badge>
                  <Badge tone={h.direction === 'outbound' ? 'outline' : 'green'}>
                    {h.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                  </Badge>
                  {h.outcome ? <Badge tone={h.outcome === 'connected' ? 'green' : 'amber'}>{titleCase(h.outcome)}</Badge> : null}
                  {h.status === 'draft' ? <Badge tone="amber">Draft — not delivered</Badge> : null}
                  {h.test_mode ? <Badge tone="amber">Test mode</Badge> : null}
                  {h.consent_ok === 0 ? <Badge tone="red">Consent not recorded</Badge> : null}
                  <span className="spacer" />
                  <span className="tiny muted">{dateTime(h.occurred_at)}</span>
                </div>
                {h.subject ? <div className="strong small">{h.subject}</div> : null}
                {h.body ? (
                  <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                    {h.body}
                  </div>
                ) : null}
                {h.outcome ? (
                  <div className="tiny muted">Outcome: {titleCase(h.outcome)}</div>
                ) : null}
                <div className="tiny muted">
                  {h.template_id ? 'From template · ' : ''}
                  Logged by {h.logged_by_name ?? user?.name ?? 'system'}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {showLog ? (
        <LogCallModal
          contactId={contactId}
          prospectId={prospectId}
          onClose={() => setShowLog(false)}
          onDone={() => {
            setShowLog(false);
            onChanged();
          }}
        />
      ) : null}

      {showText ? (
        <NoAnswerTextModal
          contactId={contactId}
          prospectId={prospectId}
          contact={contact}
          liveSms={liveSms}
          providerName={integrations.data?.sms.provider ?? 'none'}
          onClose={() => setShowText(false)}
          onDone={() => {
            setShowText(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function LogCallModal({
  contactId,
  prospectId,
  onClose,
  onDone,
}: {
  contactId: string;
  prospectId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<string>('connected');
  const [notes, setNotes] = useState('');
  const [duration, setDuration] = useState('');
  const action = useAction(async () =>
    post('/communications/call', {
      contactId,
      prospectId,
      outcome,
      notes: notes.trim() || undefined,
      durationSec: Number(duration) || undefined,
    }),
  );

  return (
    <Modal
      title="Log a call"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.pending}
            onClick={async () => {
              const res = await action.run();
              if (res) {
                toast.success('Call logged');
                onDone();
              } else if (action.error) {
                toast.error('Could not log the call', action.error.message);
              }
            }}
          >
            Save call
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error?.message ? <div className="error-state">{action.error.message}</div> : null}
        <Select
          label="Outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          options={CALL_OUTCOMES.map(([value, label]) => ({ value, label }))}
        />
        <Input
          label="Duration (seconds)"
          type="number"
          min={0}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          placeholder="180"
          hint="Optional."
        />
        <TextArea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was discussed, what happens next."
        />
      </div>
    </Modal>
  );
}

function NoAnswerTextModal({
  contactId,
  prospectId,
  contact,
  liveSms,
  providerName,
  onClose,
  onDone,
}: {
  contactId: string;
  prospectId?: string;
  contact: ContactLite;
  liveSms: boolean;
  providerName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [attempt, setAttempt] = useState<1 | 2>(1);
  const [templateKey, setTemplateKey] = useState(attempt === 1 ? 'no_answer_first' : 'no_answer_second');
  const [logCall, setLogCall] = useState(true);

  const templates = useFetch<{ rows: any[] }>('/communications/templates');
  const chosen = templates.data?.rows.find((t) => t.key === templateKey);

  const rendered = useMemo(() => {
    if (!chosen) return '';
    const senderFirst = (user?.name ?? '').trim().split(/\s+/)[0] ?? '';
    return renderTemplate(chosen.body, {
      'contact.first_name': contact.first_name,
      'contact.last_name': contact.last_name,
      'sender.name': user?.name ?? '',
      'sender.first_name': senderFirst,
    });
  }, [chosen, contact.first_name, contact.last_name, user]);

  const action = useAction(async () =>
    post('/communications/no-answer-text', {
      contactId,
      prospectId,
      attempt,
      templateKey,
      logCallAttempt: logCall,
    }),
  );

  const blockedReason = contact.consent_sms
    ? contact.opt_out_at
      ? 'This contact has opted out of SMS.'
      : null
    : 'SMS consent is not granted for this contact.';

  return (
    <Modal
      title="No-answer text"
      sub="Attempt 1 sends immediately after a call; attempt 2 follows up later the same day."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.pending}
            disabled={!!blockedReason}
            onClick={async () => {
              const res = await action.run();
              if (res) {
                const status = res.delivery?.status ?? 'draft';
                if (status === 'draft') {
                  toast.success(
                    'Draft recorded — nothing was delivered',
                    'Test mode: the message, its history and the next callback task were saved. Configure an SMS provider to send for real.',
                  );
                } else {
                  toast.success('Text queued for delivery');
                }
                onDone();
              } else if (action.error) {
                if (action.error.status === 409) {
                  toast.error('Duplicate prevented', action.error.message);
                } else {
                  toast.error('Could not send', action.error.message);
                }
              }
            }}
          >
            {liveSms ? 'Send text' : 'Record draft'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {blockedReason ? <div className="error-state">{blockedReason}</div> : null}
        {action.error?.message && action.error.status !== 409 ? (
          <div className="error-state">{action.error.message}</div>
        ) : null}
        {action.error?.status === 409 ? (
          <div className="warn-state">
            <b>Duplicate blocked.</b> {action.error.message}
            {action.error.details?.recent ? (
              <div className="tiny" style={{ marginTop: 4 }}>
                Previous attempt at {dateTime(action.error.details.recent.occurred_at)}.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="row wrap">
          <div className="segmented">
            <button className={attempt === 1 ? 'on' : ''} onClick={() => { setAttempt(1); setTemplateKey('no_answer_first'); }} type="button">
              Attempt 1
            </button>
            <button className={attempt === 2 ? 'on' : ''} onClick={() => { setAttempt(2); setTemplateKey('no_answer_second'); }} type="button">
              Attempt 2
            </button>
          </div>
        </div>

        <Select
          label="Template"
          value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)}
          options={(templates.data?.rows ?? [])
            .filter((t) => t.channel === 'text')
            .map((t) => ({ value: t.key, label: t.name }))}
        />

        <Field label="Preview" hint="Placeholders are filled by the server before delivery.">
          <div
            className="card card-pad small"
            style={{ background: 'var(--surface-2)', whiteSpace: 'pre-wrap' }}
          >
            {rendered || 'Select a template to preview it.'}
          </div>
        </Field>

        <label className="checkbox">
          <input type="checkbox" checked={logCall} onChange={(e) => setLogCall(e.target.checked)} />
          <span>
            Also record the preceding call attempt as “no answer”
            <span className="hint" style={{ display: 'block' }}>
              Keeps the dial history and this text in the same timeline.
            </span>
          </span>
        </label>

        <Callout tone="blue">
          The server creates the next callback task automatically using the configured callback
          interval, and refuses this send if a text on this template already went out recently.
        </Callout>
      </div>
    </Modal>
  );
}
