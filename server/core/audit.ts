import { newId } from './ids.js';
import { getDb, now } from '../db/database.js';

export interface AuditInput {
  requestId?: string;
  actorId?: string | null;
  actorName?: string;
  action: string;
  entityType: string;
  entityId: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

/**
 * Append-only audit trail. Never updates or deletes rows.
 * `before`/`after` capture the previous and new values for anything that
 * changed, so approvals, handoffs and pricing decisions are reconstructable.
 */
export function audit(input: AuditInput): string {
  const id = newId('aud');
  getDb()
    .prepare(
      `INSERT INTO audit_events
        (id, request_id, actor_id, actor_name, action, entity_type, entity_id,
         summary, before, after, meta, at)
       VALUES (@id, @requestId, @actorId, @actorName, @action, @entityType, @entityId,
               @summary, @before, @after, @meta, @at)`,
    )
    .run({
      id,
      requestId: input.requestId ?? null,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? '',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary ?? '',
      before: input.before === undefined ? null : JSON.stringify(input.before),
      after: input.after === undefined ? null : JSON.stringify(input.after),
      meta: input.meta === undefined ? null : JSON.stringify(input.meta),
      at: now(),
    });
  return id;
}
