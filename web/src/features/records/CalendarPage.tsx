import { useMemo, useState, type ReactNode } from 'react';
import { post, qs } from '../../lib/api';
import { useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  PageHead,
  Select,
  Stat,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateTime, initials, rel, titleCase } from '../../lib/format';
import { NewTaskModal } from './TasksPage';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  type?: string | null;
  due_at?: number | null;
  priority?: number | null;
  assignee_name?: string | null;
  [key: string]: any;
}

interface RosterRow {
  id: string;
  name: string;
}

interface CalendarData {
  rows: TaskRow[];
  overdue: TaskRow[];
  counts: { open: number; overdue: number; dueToday: number };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/** Local "YYYY-MM-DD" key so tasks land on the day the user sees. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const monthLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export default function CalendarPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canWrite = can('task.write');

  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [assignee, setAssignee] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newDue, setNewDue] = useState<number | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');
  const rosterRows = roster.data?.rows ?? [];

  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1).getTime() - 1;
  const calPath = `/tasks/calendar${qs({ from: monthStart.getTime(), to: monthEnd, assignee })}`;
  const cal = useFetch<CalendarData>(calPath, [calPath]);

  // Pinned once per month/filter so the path is stable across renders.
  const upcomingFrom = useMemo(() => Date.now(), [monthStart, assignee]);
  const upcomingPath = `/tasks${qs({ status: 'open', from: upcomingFrom, assignee, limit: 10 })}`;
  const upcoming = useFetch<{ rows: TaskRow[] }>(upcomingPath, [upcomingPath]);

  const shiftMonth = (delta: number) =>
    setMonthStart((d) => {
      const next = new Date(d.getFullYear(), d.getMonth() + delta, 1);
      next.setHours(0, 0, 0, 0);
      return next;
    });

  const goToday = () => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    setMonthStart(d);
  };

  /** Pure Date maths: leading blanks + the month's days, always whole weeks. */
  const cells = useMemo(() => {
    const y = monthStart.getFullYear();
    const m = monthStart.getMonth();
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const weeks = Math.ceil((firstWeekday + daysInMonth) / 7);
    const out: Date[] = [];
    for (let i = 0; i < weeks * 7; i++) out.push(new Date(y, m, 1 - firstWeekday + i));
    return out;
  }, [monthStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const t of cal.data?.rows ?? []) {
      if (t.due_at == null) continue;
      const key = dayKey(new Date(t.due_at));
      const bucket = map.get(key);
      if (bucket) bucket.push(t);
      else map.set(key, [t]);
    }
    return map;
  }, [cal.data]);

  const dayTasks = day ? (byDay.get(day) ?? []) : [];
  const nowMs = Date.now();

  const complete = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await post(`/tasks/${task.id}/complete`, {});
      toast.success('Task completed', task.title);
      cal.reload();
      upcoming.reload();
    } catch (err) {
      toast.error('Could not complete task', errText(err));
    } finally {
      setBusyId(null);
    }
  };

  const counts = cal.data?.counts;
  const monthTasks = cal.data?.rows ?? [];

  let main: ReactNode;
  if (cal.error && !cal.data) {
    main = <ErrorState error={cal.error} onRetry={cal.reload} />;
  } else if (cal.loading && !cal.data) {
    main = <Loading label="Loading calendar…" />;
  } else {
    main = (
      <>
        <Card
          title={monthLabel(monthStart)}
          sub={`${monthTasks.length} task${monthTasks.length === 1 ? '' : 's'} due this month`}
          flush
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, minmax(0,1fr))',
              background: 'var(--surface-2)',
              borderBottom: '1px solid var(--line)',
            }}
          >
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="tiny muted"
                style={{ textAlign: 'center', padding: '6px 0', fontWeight: 600 }}
              >
                {d}
              </div>
            ))}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, minmax(0,1fr))',
            }}
          >
            {cells.map((cell, index) => {
              const key = dayKey(cell);
              const inMonth = cell.getMonth() === monthStart.getMonth();
              const isToday = key === dayKey(new Date());
              const tasks = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  onClick={() => setDay(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setDay(key);
                  }}
                  style={{
                    minHeight: 104,
                    minWidth: 0,
                    padding: 6,
                    borderRight: (index + 1) % 7 === 0 ? 'none' : '1px solid var(--line)',
                    borderBottom: '1px solid var(--line)',
                    background: inMonth ? undefined : 'var(--surface-2)',
                    opacity: inMonth ? 1 : 0.45,
                    cursor: 'pointer',
                    outline: isToday ? '2px solid var(--accent)' : undefined,
                    outlineOffset: -2,
                  }}
                >
                  <div className="row" style={{ gap: 4 }}>
                    <span
                      style={
                        isToday
                          ? {
                              background: 'var(--accent)',
                              color: '#1a1206',
                              borderRadius: '50%',
                              width: 20,
                              height: 20,
                              display: 'grid',
                              placeItems: 'center',
                              fontSize: 11,
                              fontWeight: 700,
                            }
                          : { fontSize: 11, fontWeight: 600 }
                      }
                    >
                      {cell.getDate()}
                    </span>
                    {tasks.length ? <span className="tiny muted">{tasks.length}</span> : null}
                  </div>

                  {tasks.slice(0, 3).map((t) => {
                    const overdue = t.status === 'open' && t.due_at != null && t.due_at < nowMs;
                    return (
                      <div
                        key={t.id}
                        className="row"
                        style={{
                          gap: 4,
                          marginTop: 4,
                          minWidth: 0,
                          paddingLeft: 4,
                          borderLeft: `3px solid ${overdue ? 'var(--red)' : 'var(--line-2)'}`,
                          background: 'var(--surface-2)',
                          borderRadius: 3,
                        }}
                      >
                        <span
                          className="truncate"
                          style={{ fontSize: 11, flex: '1 1 auto', minWidth: 0 }}
                          title={t.title}
                        >
                          {t.title}
                        </span>
                        <span
                          className="avatar"
                          style={{ width: 16, height: 16, fontSize: 8 }}
                          title={t.assignee_name ?? 'Unassigned'}
                        >
                          {initials(t.assignee_name)}
                        </span>
                      </div>
                    );
                  })}
                  {tasks.length > 3 ? (
                    <div className="tiny muted" style={{ marginTop: 3 }}>
                      +{tasks.length - 3} more
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>

        {monthTasks.length === 0 ? (
          <EmptyState title="No tasks due this month" icon={<Icon name="calendar" size={22} />}>
            Nothing is scheduled for {monthLabel(monthStart)}. Create a task from any record or from
            a day on the calendar.
          </EmptyState>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Calendar"
        sub={monthLabel(monthStart)}
        actions={
          <>
            <Button
              size="sm"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
              icon={
                <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
                  <Icon name="chevronRight" size={14} />
                </span>
              }
            >
              Prev
            </Button>
            <Button size="sm" onClick={goToday}>
              Today
            </Button>
            <Button
              size="sm"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
              icon={<Icon name="chevronRight" size={14} />}
            >
              Next
            </Button>
          </>
        }
      />

      <div className="filters">
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
        <span className="spacer" />
        <Button
          size="sm"
          disabled={!canWrite || cal.loading}
          title={canWrite ? undefined : 'You do not have permission to create tasks.'}
          icon={<Icon name="plus" size={14} />}
          onClick={() => {
            setNewDue(undefined);
            setShowNew(true);
          }}
        >
          New task
        </Button>
      </div>

      {roster.error ? <ErrorState error={roster.error} onRetry={roster.reload} /> : null}

      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Stat label="Open" value={counts?.open ?? '—'} tone="info" detail="in this month" />
        <Stat label="Overdue" value={counts?.overdue ?? '—'} tone="bad" detail="past due" />
        <Stat label="Due today" value={counts?.dueToday ?? '—'} tone="accent" detail="before midnight" />
      </div>

      {/* A failed refresh keeps the previous grid on screen — never hide the failure. */}
      {cal.error && cal.data ? <ErrorState error={cal.error} onRetry={cal.reload} /> : null}

      <div className="split">
        <div className="stack">{main}</div>

        <Card title="Upcoming" sub="The next 10 open tasks by due date" flush>
          {upcoming.error && !upcoming.data ? (
            <div className="card-pad">
              <ErrorState error={upcoming.error} onRetry={upcoming.reload} />
            </div>
          ) : upcoming.loading && !upcoming.data ? (
            <div className="card-pad">
              <Loading label="Loading upcoming tasks…" />
            </div>
          ) : (upcoming.data?.rows ?? []).length === 0 ? (
            <EmptyState title="Nothing scheduled ahead" icon={<Icon name="clock" size={22} />}>
              No open tasks are due after right now.
            </EmptyState>
          ) : (
            <div className="list">
              {(upcoming.data?.rows ?? []).map((t) => (
                <div className="list-item" key={t.id} style={{ minWidth: 0 }}>
                  <span className="avatar" style={{ width: 22, height: 22, fontSize: 9 }} aria-hidden="true">
                    {initials(t.assignee_name)}
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong small truncate" title={t.title}>
                      {t.title}
                    </div>
                    <div className="tiny muted truncate">
                      {t.assignee_name ?? '—'} · {dateTime(t.due_at)}
                    </div>
                  </div>
                  <Badge tone="blue" title={String(t.due_at ?? '')}>
                    {rel(t.due_at)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {day ? (
        <Modal
          title={day ? new Date(`${day}T00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : ''}
          sub={`${dayTasks.length} task${dayTasks.length === 1 ? '' : 's'} due`}
          onClose={() => setDay(null)}
          footer={
            <>
              <Button type="button" onClick={() => setDay(null)}>
                Close
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : 'You do not have permission to create tasks.'}
                onClick={() => {
                  // Prefill the new-task form with the day that was clicked.
                  const start = new Date(`${day}T09:00`);
                  const at = Number.isNaN(start.getTime()) ? undefined : start.getTime();
                  setNewDue(at);
                  setDay(null);
                  setShowNew(true);
                }}
              >
                New task
              </Button>
            </>
          }
        >
          {dayTasks.length === 0 ? (
            <EmptyState title="Nothing due this day" icon={<Icon name="calendar" size={22} />}>
              Click “New task” to schedule something on this date.
            </EmptyState>
          ) : (
            <div className="list">
              {dayTasks.map((t) => {
                const overdue = t.status === 'open' && t.due_at != null && t.due_at < Date.now();
                return (
                  <div className="list-item" key={t.id} style={{ minWidth: 0 }}>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className="strong small truncate" title={t.title}>
                          {t.title}
                        </span>
                        <Badge tone={t.status === 'done' ? 'green' : t.status === 'cancelled' ? 'neutral' : 'outline'}>
                          {titleCase(t.status)}
                        </Badge>
                        {t.type ? <Badge tone="violet">{titleCase(t.type)}</Badge> : null}
                        {t.priority === 1 ? <Badge tone="red">High</Badge> : null}
                      </div>
                      <div className="tiny muted">
                        {t.assignee_name ?? '—'} · {dateTime(t.due_at)} ·{' '}
                        {overdue ? (
                          <span style={{ color: 'var(--red)', fontWeight: 600 }}>overdue</span>
                        ) : (
                          rel(t.due_at)
                        )}
                      </div>
                    </div>
                    {t.status === 'open' ? (
                      <Button
                        size="sm"
                        variant="success"
                        disabled={!canWrite || busyId === t.id}
                        loading={busyId === t.id}
                        title={canWrite ? undefined : 'You do not have permission to manage tasks.'}
                        onClick={() => void complete(t)}
                      >
                        Complete
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      ) : null}

      {showNew ? (
        <NewTaskModal
          roster={rosterRows}
          defaultDueAt={newDue}
          onClose={() => setShowNew(false)}
          onDone={() => {
            setShowNew(false);
            cal.reload();
            upcoming.reload();
          }}
        />
      ) : null}
    </>
  );
}
