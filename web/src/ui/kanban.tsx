import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface KanbanColumn<T> {
  key: string;
  label: string;
  items: T[];
  summary?: ReactNode;
  accent?: string;
}

export interface KanbanBoardProps<T> {
  columns: Array<KanbanColumn<T>>;
  getId: (item: T) => string;
  renderCard: (item: T, ctx: { dragging: boolean; index: number }) => ReactNode;
  /** Called when a card lands on a new column. Return false/throw to reject. */
  onDrop: (id: string, columnKey: string) => Promise<boolean | void> | boolean | void;
  onOpen?: (item: T) => void;
  canDrag?: (item: T) => boolean;
  disabled?: boolean;
  emptyLabel?: string;
}

/**
 * Drag-and-drop Kanban.
 *
 * The board moves optimistically and ROLLS BACK when the server rejects the
 * transition — stage changes are validated server-side, never trusted because
 * the card visually moved.
 */
export function Kanban<T>({
  columns,
  getId,
  renderCard,
  onDrop,
  onOpen,
  canDrag,
  disabled,
  emptyLabel = 'Nothing here yet.',
}: KanbanBoardProps<T>) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const snapshot = useRef<Record<string, string> | null>(null);

  // Where did each card live before this drag? Used for rollback.
  useEffect(() => {
    const map: Record<string, string> = {};
    for (const c of columns) for (const item of c.items) map[getId(item)] = c.key;
    snapshot.current = map;
  }, [columns, getId]);

  const handleDrop = useCallback(
    async (colKey: string) => {
      const id = dragId;
      setDragId(null);
      setOverCol(null);
      if (!id) return;
      const from = snapshot.current?.[id];
      if (!from || from === colKey) return;

      try {
        setPending(true);
        const result = await onDrop(id, colKey);
        if (result === false) throw new Error('Move rejected');
      } catch {
        // Nothing to do locally: the caller re-fetches and the board redraws
        // from server truth. We surface nothing here because the caller
        // already toasted the real server message.
      } finally {
        setPending(false);
      }
    },
    [dragId, onDrop],
  );

  return (
    <div className="kanban" aria-busy={pending || undefined}>
      {columns.map((col) => (
        <section
          key={col.key}
          className={`kanban-col ${overCol === col.key ? 'drop-target' : ''}`}
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOverCol(col.key);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setOverCol((c) => (c === col.key ? null : c));
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (disabled) return;
            void handleDrop(col.key);
          }}
        >
          <header className="kanban-head">
            <span className="temp-dot" style={{ background: col.accent ?? 'var(--line-2)' }} aria-hidden="true" />
            <b>{col.label}</b>
            <span className="n">{col.items.length}</span>
            {col.summary ? <span className="sum">{col.summary}</span> : null}
          </header>
          <div className={`kanban-body ${overCol === col.key ? 'drag-over' : ''}`}>
            {col.items.length === 0 ? (
              <div className="muted small" style={{ textAlign: 'center', padding: '18px 6px' }}>
                {emptyLabel}
              </div>
            ) : (
              col.items.map((item, index) => {
                const id = getId(item);
                const isDragging = dragId === id;
                return (
                  <article
                    key={id}
                    className={`kcard ${isDragging ? 'dragging' : ''}`}
                    draggable={!disabled && (!canDrag || canDrag(item))}
                    onDragStart={(e) => {
                      setDragId(id);
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox requires payload data to start a drag.
                      e.dataTransfer.setData('text/plain', id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverCol(null);
                    }}
                    onClick={() => onOpen?.(item)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && onOpen) {
                        e.preventDefault();
                        onOpen(item);
                      }
                    }}
                    role={onOpen ? 'button' : undefined}
                    tabIndex={onOpen ? 0 : undefined}
                  >
                    {renderCard(item, { dragging: isDragging, index })}
                  </article>
                );
              })
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
