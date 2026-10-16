import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, ApiError } from '../../lib/api';
import { useFetch, useAction } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  Select,
  TextArea,
  Field,
  Tabs,
} from '../../ui';
import { Icon } from '../../ui/icons';
import {
  dateShort,
  dateTime,
  money,
  rel,
  titleCase,
  TEMPERATURE_LABELS,
} from '../../lib/format';
import { CommunicationPanel } from './CommunicationPanel';

export interface ContactCardData {
  contact: any;
  prospects: any[];
  bids: any[];
  deals: any[];
  contracts: any[];
  projects: any[];
  communications: any[];
  tasks: any[];
  documents: any[];
  activity: any[];
  counts: Record<string, number>;
}

/**
 * The unified contact card.
 *
 * Every section below is a live query over records that already exist in
 * their own workspace — nothing is copied in, so the card can never drift
 * from the record it points at.
 */
export function ContactCard({
  contactId,
  onClosed,
  onChanged,
}: {
  contactId: string;
  onClosed?: () => void;
  onChanged?: () => void;
}) {
  const { data, error, loading, reload } = useFetch<ContactCardData>(
    `/contacts/${contactId}/card`,
    [contactId],
  );
  const [tab, setTab] = useState('overview');

  if (loading && !data) return <Loading label="Loading contact…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const c = data.contact;
  const fullName = `${c.first_name} ${c.last_name}`.trim();

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'communications', label: 'Communications', count: data.counts.communications },
    { key: 'records', label: 'Records', count: data.counts.prospects + data.counts.bids + data.counts.deals + data.counts.projects },
    { key: 'tasks', label: 'Open tasks', count: data.counts.openTasks },
    { key: 'activity', label: 'Activity' },
  ];

  return (
    <div className="stack">
      <header className="row wrap" style={{ gap: 12 }}>
        <div className="avatar" style={{ width: 42, height: 42, fontSize: 15 }} aria-hidden="true">
          {fullName
            .split(/\s+/)
            .map((p: string) => p[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 17 }}>{fullName}</h2>
          <div className="small muted">
            {c.title ? <span>{c.title} · </span> : null}
            {c.company_name ? <span>{c.company_name} · </span> : null}
            <span>{c.is_decision_maker ? 'Decision-maker' : 'Contact'}</span>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {c.phone || c.mobile ? (
            <a className="btn btn-sm" href={`tel:${c.phone ?? c.mobile}`}>
              <Icon name="phone" size={14} /> {c.phone ?? c.mobile}
            </a>
          ) : null}
          {c.email ? (
            <a className="btn btn-sm" href={`mailto:${c.email}`}>
              <Icon name="mail" size={14} /> Email
            </a>
          ) : null}
          {onClosed ? (
            <Button size="sm" variant="ghost" onClick={onClosed}>
              Close
            </Button>
          ) : null}
        </div>
      </header>

      {(c.consent_sms === 0 || c.opt_out_at) && (
        <div className="warn-state small">
          SMS consent is <strong>not</strong> granted{c.opt_out_at ? ' and this contact has opted out' : ''}.
          Text automation will be refused for this record.
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' && <Overview data={data} onChanged={reload} />}
      {tab === 'communications' && (
        <CommunicationPanel
          contactId={contactId}
          contact={c}
          history={data.communications}
          onChanged={() => {
            reload();
            onChanged?.();
          }}
        />
      )}
      {tab === 'records' && <Records data={data} onChanged={reload} />}
      {tab === 'tasks' && <TaskList tasks={data.tasks} onChanged={reload} />}
      {tab === 'activity' && <Activity events={data.activity} />}
    </div>
  );
}

function Overview({ data, onChanged }: { data: ContactCardData; onChanged: () => void }) {
  const c = data.contact;
  const nextTask = data.tasks[0];
  const latestComm = data.communications[0];
  const openProspect = data.prospects.find((p) => !p.handoff_at);

  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="stat accent">
          <div className="k">Prospects</div>
          <div className="v">{data.counts.prospects}</div>
        </div>
        <div className="stat info">
          <div className="k">Bids</div>
          <div className="v">{data.counts.bids}</div>
        </div>
        <div className="stat">
          <div className="k">Deals</div>
          <div className="v">{data.counts.deals}</div>
        </div>
        <div className="stat good">
          <div className="k">Projects</div>
          <div className="v">{data.counts.projects}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <Card title="Contact details">
          <dl className="kv">
            <dt>Phone</dt>
            <dd className="mono">{c.phone || '—'}</dd>
            <dt>Mobile</dt>
            <dd className="mono">{c.mobile || '—'}</dd>
            <dt>Email</dt>
            <dd>{c.email || '—'}</dd>
            <dt>Preferred</dt>
            <dd>{titleCase(c.contact_pref)}</dd>
            <dt>SMS consent</dt>
            <dd>
              {c.consent_sms ? (
                <Badge tone="green">Granted</Badge>
              ) : (
                <Badge tone="red">Not granted</Badge>
              )}
            </dd>
            <dt>Decision-maker</dt>
            <dd>{c.is_decision_maker ? 'Yes' : 'No'}</dd>
            {c.notes ? (
              <>
                <dt>Notes</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</dd>
              </>
            ) : null}
          </dl>
        </Card>

        <Card title="Next action" sub="Live from the task list">
          {nextTask ? (
            <div className="stack">
              <div className="row">
                <Badge tone={nextTask.due_at < Date.now() ? 'red' : 'blue'}>
                  {rel(nextTask.due_at)}
                </Badge>
                <span className="grow strong">{nextTask.title}</span>
              </div>
              <div className="small muted">
                Assigned to {nextTask.assignee_name} · due {dateTime(nextTask.due_at)}
              </div>
              <div className="row wrap">
                <Button size="sm" onClick={() => void post(`/tasks/${nextTask.id}/complete`, {}).then(onChanged)}>
                  <Icon name="check" size={14} /> Mark complete
                </Button>
                <Link className="btn btn-sm" to="/tasks">
                  All tasks
                </Link>
              </div>
            </div>
          ) : (
            <EmptyState title="No open tasks" icon={<span>✓</span>}>
              Nothing is scheduled for this contact right now.
            </EmptyState>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Latest communication" flush>
          {latestComm ? (
            <div className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <div className="row wrap">
                <Badge tone={latestComm.channel === 'call' ? 'blue' : latestComm.channel === 'text' ? 'violet' : 'accent'}>
                  {titleCase(latestComm.channel)}
                </Badge>
                <Badge tone={latestComm.direction === 'outbound' ? 'neutral' : 'green'}>
                  {latestComm.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                </Badge>
                {latestComm.test_mode ? <Badge tone="amber">Test mode</Badge> : null}
                <span className="spacer" />
                <span className="small muted">{dateTime(latestComm.occurred_at)}</span>
              </div>
              {latestComm.subject ? <div className="strong small">{latestComm.subject}</div> : null}
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {latestComm.body}
              </div>
              <div className="tiny muted">Logged by {latestComm.logged_by_name ?? 'system'}</div>
            </div>
          ) : (
            <EmptyState title="No communications yet" icon={<span>☎</span>}>
              Calls, texts, emails and notes logged against this contact appear here.
            </EmptyState>
          )}
        </Card>

        <Card title="Open pursuit" sub="The prospect currently driving this relationship">
          {openProspect ? (
            <div className="stack">
              <div className="row wrap">
                <Badge tone="accent">{titleCase(openProspect.stage)}</Badge>
                <Badge tone="neutral">{TEMPERATURE_LABELS[openProspect.temperature] ?? openProspect.temperature}</Badge>
                {openProspect.disposition_name ? <Badge tone="blue">{openProspect.disposition_name}</Badge> : null}
              </div>
              <div className="small">{openProspect.scope_summary || 'No scope summary yet.'}</div>
              <dl className="kv">
                <dt>Next follow-up</dt>
                <dd>{openProspect.next_followup_at ? rel(openProspect.next_followup_at) : '—'}</dd>
                <dt>Source</dt>
                <dd>{openProspect.source_name ?? '—'}</dd>
                <dt>Owner</dt>
                <dd>{openProspect.owner_name ?? '—'}</dd>
              </dl>
              <Link className="btn btn-sm" to={`/prospects/${openProspect.id}`}>
                Open prospect <Icon name="arrowRight" size={14} />
              </Link>
            </div>
          ) : (
            <EmptyState title="No open prospect" icon={<span>◎</span>}>
              {data.prospects.length
                ? 'Every prospect for this contact has been handed off or archived.'
                : 'Create a prospect to start tracking this relationship.'}
            </EmptyState>
          )}
        </Card>
      </div>

      <Documents docs={data.documents} />
    </div>
  );
}

function Documents({ docs }: { docs: any[] }) {
  return (
    <Card title="Documents" sub="Plans, attachments and contracts held against this contact" flush>
      {docs.length === 0 ? (
        <EmptyState title="No documents" icon={<span>📄</span>}>
          Documents uploaded to prospects, bids and contracts are listed here.
        </EmptyState>
      ) : (
        <div className="list">
          {docs.map((d) => (
            <div className="list-item" key={d.id}>
              <Icon name="file" size={16} />
              <div className="grow">
                <div className="strong small">{d.filename}</div>
                <div className="tiny muted">
                  {titleCase(d.kind)} · v{d.version} · {dateShort(d.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Records({ data, onChanged }: { data: ContactCardData; onChanged: () => void }) {
  return (
    <div className="stack">
      <Card title="Prospects" flush>
        <List rows={data.prospects} empty="No prospects on record.">
          {(p) => (
            <>
              <div className="row wrap">
                <Badge tone="accent">{titleCase(p.stage)}</Badge>
                <Badge tone={p.temperature === 'hot' ? 'red' : p.temperature === 'warm' ? 'amber' : 'blue'}>
                  {TEMPERATURE_LABELS[p.temperature] ?? p.temperature}
                </Badge>
                {p.disposition_name ? <Badge tone="neutral">{p.disposition_name}</Badge> : null}
                {p.handoff_at ? <Badge tone="green">Handed off</Badge> : null}
              </div>
              <div className="small muted">{p.scope_summary || 'No scope summary'}</div>
              <Link className="tiny" to={`/prospects/${p.id}`}>
                Open prospect →
              </Link>
            </>
          )}
        </List>
      </Card>

      <Card title="Bids" flush>
        <List rows={data.bids} empty="No bids yet.">
          {(b) => (
            <>
              <div className="row wrap">
                <span className="mono strong small">{b.bid_no}</span>
                <Badge tone="blue">{titleCase(b.trade || 'general')}</Badge>
                <Badge tone="neutral">{titleCase(b.stage)}</Badge>
                {b.disposition_name ? <Badge tone="outline">{b.disposition_name}</Badge> : null}
              </div>
              <div className="small muted">{b.project_address || b.scope_summary}</div>
              <Link className="tiny" to={`/bids/${b.id}`}>
                Open bid →
              </Link>
            </>
          )}
        </List>
      </Card>

      <Card title="Deals" flush>
        <List rows={data.deals} empty="No deals yet.">
          {(d) => (
            <>
              <div className="row wrap">
                <span className="mono strong small">{d.deal_no}</span>
                <Badge tone={d.stage === 'won' ? 'green' : d.stage === 'lost' ? 'red' : 'accent'}>
                  {titleCase(d.stage)}
                </Badge>
                <span className="spacer" />
                <span className="mono small strong">{money(d.value)}</span>
              </div>
              <div className="small muted">{d.project_name}</div>
              <Link className="tiny" to={`/deals/${d.id}`}>
                Open deal →
              </Link>
            </>
          )}
        </List>
      </Card>

      <Card title="Contracts" flush>
        <List rows={data.contracts} empty="No contracts issued.">
          {(ct) => (
            <div className="row wrap">
              <span className="strong small">v{ct.version}</span>
              <Badge tone={ct.signature_status === 'signed' ? 'green' : ct.signature_status === 'declined' ? 'red' : 'amber'}>
                {titleCase(ct.signature_status)}
              </Badge>
              <span className="spacer" />
              <span className="mono small">{money(ct.amount, { cents: true })}</span>
            </div>
          )}
        </List>
      </Card>

      <Card title="Projects" flush>
        <List rows={data.projects} empty="No projects yet.">
          {(p) => (
            <>
              <div className="row wrap">
                <span className="mono strong small">{p.project_no}</span>
                <Badge tone={p.status === 'active' ? 'green' : 'neutral'}>{titleCase(p.status)}</Badge>
                <span className="spacer" />
                <span className="mono small">{money(p.original_contract)}</span>
              </div>
              <div className="small muted">{p.name}</div>
              <Link className="tiny" to={`/projects/${p.id}`}>
                Open project →
              </Link>
            </>
          )}
        </List>
      </Card>
      <div className="spacer" />
      <OnChangeHack onChanged={onChanged} />
    </div>
  );
}

/** No-op spacer so `Records` keeps its prop without forcing a refactor. */
function OnChangeHack({ onChanged }: { onChanged: () => void }) {
  void onChanged;
  return null;
}

function List({ rows, empty, children }: { rows: any[]; empty: string; children: (row: any) => React.ReactNode }) {
  if (!rows.length) {
    return <EmptyState title={empty} icon={<span>—</span>} />;
  }
  return (
    <div className="list">
      {rows.map((r) => (
        <div className="list-item clickable" key={r.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 5 }}>
          {children(r)}
        </div>
      ))}
    </div>
  );
}

function TaskList({ tasks, onChanged }: { tasks: any[]; onChanged: () => void }) {
  const toast = useToast();
  if (!tasks.length) {
    return (
      <Card title="Open tasks">
        <EmptyState title="Nothing outstanding" icon={<span>✓</span>}>
          All follow-ups for this contact are complete.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card title="Open tasks" flush>
      <div className="list">
        {tasks.map((t) => (
          <div className="list-item" key={t.id}>
            <div className="grow">
              <div className="strong small">{t.title}</div>
              <div className="tiny muted">
                {t.assignee_name} · due {dateTime(t.due_at)} ·{' '}
                {t.due_at < Date.now() ? <span style={{ color: 'var(--red)' }}>overdue</span> : rel(t.due_at)}
              </div>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await post(`/tasks/${t.id}/complete`, {});
                  toast.success('Task completed');
                  onChanged();
                } catch (err) {
                  toast.error('Could not complete task', err instanceof Error ? err.message : undefined);
                }
              }}
            >
              Complete
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Activity({ events }: { events: any[] }) {
  if (!events.length) {
    return (
      <Card title="Activity">
        <EmptyState title="No recorded activity" icon={<span>⟲</span>}>
          Every create, edit, approval and handoff is written to the audit trail with its actor and
          previous values.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card title="Activity" sub="From the append-only audit trail" flush>
      <div className="list">
        {events.map((e) => (
          <div className="list-item" key={e.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
            <div className="row wrap">
              <Badge tone={e.action.includes('archived') || e.action.includes('failed') ? 'red' : e.action.includes('won') || e.action.includes('approved') || e.action.includes('handoff') ? 'green' : 'neutral'}>
                {titleCase(e.action)}
              </Badge>
              <span className="spacer" />
              <span className="tiny muted">{dateTime(e.at)}</span>
            </div>
            <div className="small">{e.summary}</div>
            <div className="tiny muted">{e.actor_name || 'System'}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
