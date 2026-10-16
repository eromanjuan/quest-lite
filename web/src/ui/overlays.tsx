import { useEffect, type ReactNode } from 'react';
import { Button } from './primitives';

export function Modal({
  title,
  sub,
  children,
  footer,
  onClose,
  size = 'md',
  closeOnScrim = true,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  closeOnScrim?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (closeOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <header className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub ? <div className="sub muted small">{sub}</div> : null}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/**
 * Confirmation dialog. Destructive actions must state their consequence
 * in `confirmLabel` rather than just saying "OK".
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary' | 'success';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">{typeof message === 'string' ? <p>{message}</p> : message}{children}</div>
    </Modal>
  );
}

export function Drawer({
  title,
  sub,
  children,
  onClose,
  footer,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="overlay" style={{ placeItems: 'stretch', padding: 0 }} onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {sub ? <div className="sub muted small">{sub}</div> : null}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </aside>
    </>
  );
}
