import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

/* ----------------------------- Button ------------------------------ */

type Variant = 'default' | 'primary' | 'danger' | 'success' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  icon,
  block,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size !== 'md' ? `btn-${size}` : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'default',
  size = 'md',
  icon,
  children,
  className = '',
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const cls = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size !== 'md' ? `btn-${size}` : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link to={to} className={cls}>
      {icon}
      {children}
    </Link>
  );
}

/* ----------------------------- Badge ------------------------------- */

export type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber' | 'accent' | 'violet' | 'outline';

export function Badge({
  tone = 'neutral',
  dot,
  children,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------ Card ------------------------------- */

export function Card({
  title,
  sub,
  actions,
  children,
  footer,
  flush,
  className = '',
  as: As = 'section',
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  as?: any;
}) {
  return (
    <As className={`card ${className}`}>
      {title || actions ? (
        <header className="card-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
      {footer ? <footer className="card-foot">{footer}</footer> : null}
    </As>
  );
}

export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'accent' | 'good' | 'bad' | 'info';
}) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

export function PageHead({
  title,
  sub,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="page-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {sub ? <div className="sub">{sub}</div> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {children}
    </>
  );
}

/* ----------------------------- States ------------------------------ */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="ico" aria-hidden="true">
        {icon ?? '—'}
      </div>
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="error-state" role="alert">
      <div className="row">
        <span className="grow">{message}</span>
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Callout({
  tone = '',
  children,
}: {
  tone?: '' | 'blue' | 'red' | 'green' | 'grey';
  children: ReactNode;
}) {
  return <div className={`callout ${tone}`}>{children}</div>;
}

export function Meter({ value, tone }: { value: number; tone?: 'good' | 'bad' | 'warn' }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={`meter ${tone ?? ''}`} aria-hidden="true">
      <i style={{ width: `${v}%` }} />
    </div>
  );
}

/* ------------------------------ Tabs ------------------------------- */

export interface TabDef {
  key: string;
  label: string;
  count?: number;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`tab ${active === t.key ? 'on' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined ? <span className="n">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------- Misc helpers -------------------------- */

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TemperatureDot({ value }: { value: string }) {
  return (
    <span
      className={`temp-dot temp-${value}`}
      title={`${value} temperature`}
      aria-label={`${value} temperature`}
    />
  );
}

export function BlockerList({ items }: { items: Array<{ label: string; detail?: string; passed?: boolean }> }) {
  if (!items.length) return null;
  return (
    <ul className="blockers">
      {items.map((b, i) => (
        <li key={i} className={b.passed ? 'ok' : ''}>
          <span aria-hidden="true">{b.passed ? '✓' : '✕'}</span>
          <span>
            <span className="lbl">{b.label}</span>
            {b.detail ? <span className="det"> — {b.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
