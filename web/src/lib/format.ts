/** Formatting helpers shared by every workspace. */

/**
 * Anything the date helpers accept. Callers hold epoch milliseconds from the
 * API, ISO strings, or an already-parsed `Date`, so all three are valid input
 * rather than forcing every caller to normalise first.
 */
export type DateInput = number | string | Date | null | undefined;

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const USD2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(v: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (opts.cents ? USD2 : USD).format(v);
}

export function money2(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return USD2.format(v);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function pctRaw(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString('en-US');
}

export function date(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateShort(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

export function time(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  return `${dateShort(d)} · ${time(d)}`;
}

export function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Human relative time: "3h ago", "in 2d", "just now". */
export function rel(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '—';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const future = diff > 0;
  if (mins < 1) return 'just now';
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return future ? `in ${days}d` : `${days}d ago`;
  return dateShort(d);
}

export function daysSince(v: DateInput): number | null {
  const d = toDate(v);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

export function isOverdue(v: DateInput): boolean {
  const d = toDate(v);
  return !!d && d.getTime() < Date.now();
}

export function isToday(v: DateInput): boolean {
  const d = toDate(v);
  if (!d) return false;
  const n = new Date();
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function titleCase(v: string | null | undefined): string {
  if (!v) return '';
  return v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turns a template like "Hey {contact.first_name}" into a rendered body. */
export function renderTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    const v = vars[key];
    return v === undefined || v === null || v === '' ? match : v;
  });
}

export function toLocalInputValue(v: DateInput): string {
  const d = toDate(v);
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInputValue(v: string): number | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export const TRADE_LABELS: Record<string, string> = {
  roofing: 'Roofing',
  framing: 'Framing',
  demolition: 'Demolition',
};

export const TEMPERATURE_LABELS: Record<string, string> = {
  hot: 'Hot',
  warm: 'Warm',
  cold: 'Cold',
};

export function stageLabel(stage: string): string {
  return titleCase(stage);
}
