import type { Db } from '../db/index.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  /** Must never contain secrets. */
  details?: Record<string, unknown>;
}

/** Security-relevant events, retained in the database for administrators. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      ip: entry.ip ?? null,
      details: JSON.stringify(entry.details ?? {}),
    })
    .execute();
}
