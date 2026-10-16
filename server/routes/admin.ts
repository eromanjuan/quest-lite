import { Router } from 'express';
import { z } from 'zod';

import { getDb, now, tx } from '../db/database.js';
import { requireAuth, requirePermission, currentUser, userCan } from '../auth/middleware.js';
import { ah, parseBody, must, parsePagination, page, conflict, forbidden, notFound } from '../http/helpers.js';
import { audit } from '../core/audit.js';
import { newId } from '../core/ids.js';
import { round2 } from '../core/money.js';
import { ROLES, PERMISSIONS, ROLE_PERMISSIONS } from '../core/permissions.js';
import { readSetting } from './config.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

/* ================================================================== */
/* Roles & permissions                                                 */
/* ================================================================== */

adminRouter.get(
  '/roles',
  requirePermission('admin.manage'),
  ah(async (_req, res) => {
    // Live counts, not a copy: whoever has the permission sees today's truth.
    const counts = getDb()
      .prepare('SELECT role_key, COUNT(*) AS n FROM users WHERE active = 1 GROUP BY role_key')
      .all() as { role_key: string; n: number }[];
    const userCounts: Record<string, number> = {};
    for (const key of Object.keys(ROLES)) userCounts[key] = 0;
    for (const c of counts) if (c.role_key in userCounts) userCounts[c.role_key] = Number(c.n);

    res.json({
      roles: ROLES,
      permissions: PERMISSIONS,
      rolePermissions: ROLE_PERMISSIONS,
      userCounts,
    });
  }),
);

/* ================================================================== */
/* Audit trail                                                         */
/* ================================================================== */

function jsonOrRaw(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

adminRouter.get(
  '/audit',
  requirePermission('audit.view'),
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 50);
    const q = req.query as any;

    const where: string[] = [];
    const params: any[] = [];
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const num = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    if (str(q.entityType)) { where.push('entity_type = ?'); params.push(str(q.entityType)); }
    if (str(q.entityId)) { where.push('entity_id = ?'); params.push(str(q.entityId)); }
    if (str(q.actorId)) { where.push('actor_id = ?'); params.push(str(q.actorId)); }
    if (str(q.action)) { where.push('action = ?'); params.push(str(q.action)); }
    const from = num(q.from);
    if (from !== null) { where.push('at >= ?'); params.push(from); }
    const to = num(q.to);
    if (to !== null) { where.push('at <= ?'); params.push(to); }
    if (str(q.q)) { where.push('summary LIKE ?'); params.push(`%${str(q.q)}%`); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM audit_events ${clause}`).get(...params) as any).n ?? 0,
    );
    const rows = getDb()
      .prepare(`SELECT * FROM audit_events ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as any[];

    res.json(
      page(
        rows.map((r) => ({
          ...r,
          before: jsonOrRaw(r.before),
          after: jsonOrRaw(r.after),
          meta: jsonOrRaw(r.meta),
        })),
        total,
        limit,
        offset,
      ),
    );
  }),
);

/* ================================================================== */
/* Price book                                                          */
/* ================================================================== */

adminRouter.get(
  '/price-book',
  requirePermission('pricebook.read'),
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 50);
    const q = req.query as any;

    const where: string[] = [];
    const params: any[] = [];
    const term = typeof q.q === 'string' ? q.q.trim() : '';
    if (term) {
      where.push('(pb.code LIKE ? OR pb.name LIKE ?)');
      params.push(`%${term}%`, `%${term}%`);
    }
    const vendorId = typeof q.vendorId === 'string' ? q.vendorId.trim() : '';
    if (vendorId) { where.push('pb.vendor_id = ?'); params.push(vendorId); }
    const taxClass = typeof q.taxClass === 'string' ? q.taxClass.trim() : '';
    if (taxClass) { where.push('pb.tax_class = ?'); params.push(taxClass); }
    // Default: active items only. `active=all` lists everything; any other
    // explicit value filters on that exact flag (0/1).
    if (q.active === undefined || q.active === '') {
      where.push('pb.active = 1');
    } else if (q.active !== 'all') {
      where.push('pb.active = ?');
      params.push(q.active === '0' || q.active === 'false' ? 0 : 1);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM price_book_items pb ${clause}`).get(...params) as any).n ?? 0,
    );
    const rows = getDb()
      .prepare(
        `SELECT pb.*, v.name AS vendor_name
           FROM price_book_items pb LEFT JOIN vendors v ON v.id = pb.vendor_id
          ${clause}
          ORDER BY pb.code COLLATE NOCASE
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const priceBookCreateSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  vendorId: z.string().trim().min(1).nullish(),
  unit: z.string().trim().min(1).max(24).default('EA'),
  price: z.number().nonnegative(),
  taxClass: z.enum(['taxable', 'exempt']).default('taxable'),
  effectiveFrom: z.number().int().positive().nullish(),
  protected: z.boolean().default(false),
});

adminRouter.post(
  '/price-book',
  requirePermission('pricebook.write'),
  ah(async (req, res) => {
    const input = parseBody(priceBookCreateSchema, req.body);
    const actor = currentUser(req);
    const id = newId('pbi');
    const at = now();

    tx((db) => {
      // Uniqueness is enforced inside the transaction so a race cannot
      // produce two rows that share a code (the unique index would abort
      // anyway — this turns it into a clear 409).
      const clash = db.prepare('SELECT id FROM price_book_items WHERE code = ?').get(input.code) as any;
      if (clash) {
        throw conflict(
          `Price book code "${input.code}" already exists. Codes must be unique — pick another or edit the existing item.`,
          { existingId: clash.id },
        );
      }
      if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');

      db.prepare(
        `INSERT INTO price_book_items
           (id, code, name, vendor_id, unit, price, tax_class, effective_from, protected, active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        id, input.code, input.name, input.vendorId ?? null, input.unit,
        round2(input.price), input.taxClass, input.effectiveFrom ?? at,
        input.protected ? 1 : 0, actor.id, at, at,
      );

      // The first revision records the initial price/tax class so every
      // later change has something to diff against. Revisions are
      // append-only: this row is never rewritten.
      db.prepare(
        `INSERT INTO price_book_revisions (id, item_id, price, tax_class, effective_from, changed_by, changed_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId('pbr'), id, round2(input.price), input.taxClass, input.effectiveFrom ?? at, actor.id, at, 'Initial entry');
    });

    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'price_book.created',
      entityType: 'price_book_item',
      entityId: id,
      summary: `Created price book item "${input.code}" (${input.name})`,
      after: {
        code: input.code,
        name: input.name,
        price: round2(input.price),
        taxClass: input.taxClass,
        unit: input.unit,
        vendorId: input.vendorId ?? null,
        protected: input.protected,
      },
    });

    res.status(201).json({ row: getDb().prepare('SELECT * FROM price_book_items WHERE id = ?').get(id) });
  }),
);

const priceBookPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  price: z.number().nonnegative().optional(),
  taxClass: z.enum(['taxable', 'exempt']).optional(),
  unit: z.string().trim().min(1).max(24).optional(),
  vendorId: z.string().trim().min(1).nullish(),
  active: z.boolean().optional(),
  effectiveFrom: z.number().int().positive().optional(),
  note: z.string().trim().max(500).default(''),
});

adminRouter.patch(
  '/price-book/:id',
  requirePermission('pricebook.write'),
  ah(async (req, res) => {
    const input = parseBody(priceBookPatchSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM price_book_items WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Price book item not found.');
    if (input.vendorId) must(db.prepare('SELECT id FROM vendors WHERE id = ?').get(input.vendorId), 'Vendor');

    // PROTECTED ITEMS: price/tax-class changes are gated on a SECOND, finer
    // permission. pricebook.write alone edits name/unit/vendor/active; only
    // pricebook.protected_write may move price or tax class on an item
    // flagged protected = 1. The check is on an actual change, so a no-op
    // PATCH of the same value does not trip it.
    const changesPrice = input.price !== undefined && round2(input.price) !== Number(before.price);
    const changesTax = input.taxClass !== undefined && input.taxClass !== before.tax_class;
    if (before.protected === 1 && (changesPrice || changesTax) && !userCan(req, 'pricebook.protected_write')) {
      throw forbidden(
        `This price book item is protected. Changing its price or tax class requires the "pricebook.protected_write" permission (your role is ${actor.role}).`,
      );
    }

    const at = now();
    const patch: any = {
      name: input.name ?? before.name,
      price: input.price === undefined ? before.price : round2(input.price),
      tax_class: input.taxClass ?? before.tax_class,
      unit: input.unit ?? before.unit,
      vendor_id: input.vendorId === undefined ? before.vendor_id : input.vendorId,
      active: input.active === undefined ? before.active : input.active ? 1 : 0,
      effective_from: input.effectiveFrom ?? before.effective_from,
    };

    tx((txdb) => {
      txdb
        .prepare(
          `UPDATE price_book_items SET
             name = @name, price = @price, tax_class = @tax_class, unit = @unit,
             vendor_id = @vendor_id, active = @active, effective_from = @effective_from,
             updated_at = @updated_at
           WHERE id = @id`,
        )
        .run({ ...patch, updated_at: at, id: before.id });

      // Whenever price or tax class actually moved, append a revision row
      // capturing the NEW values with who/when/why. Old revisions are never
      // overwritten — history stays reconstructable.
      if (changesPrice || changesTax) {
        txdb
          .prepare(
            `INSERT INTO price_book_revisions (id, item_id, price, tax_class, effective_from, changed_by, changed_at, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId('pbr'), before.id, patch.price, patch.tax_class,
            patch.effective_from, actor.id, at, input.note ?? '',
          );
      }
    });

    const after = db.prepare('SELECT * FROM price_book_items WHERE id = ?').get(before.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'price_book.updated',
      entityType: 'price_book_item',
      entityId: String(before.id),
      summary: `Updated price book item "${before.code}"`,
      before,
      after,
      meta: { changedPrice: changesPrice, changedTaxClass: changesTax, note: input.note || null },
    });
    res.json({ row: after });
  }),
);

adminRouter.get(
  '/price-book/:id/history',
  requirePermission('pricebook.read'),
  ah(async (req, res) => {
    const db = getDb();
    const item = must(
      db
        .prepare(
          `SELECT pb.*, v.name AS vendor_name
             FROM price_book_items pb LEFT JOIN vendors v ON v.id = pb.vendor_id
            WHERE pb.id = ?`,
        )
        .get(req.params.id),
      'Price book item',
    );
    const revisions = db
      .prepare(
        `SELECT r.*, u.name AS changed_by_name
           FROM price_book_revisions r LEFT JOIN users u ON u.id = r.changed_by
          WHERE r.item_id = ?
          ORDER BY r.changed_at DESC, r.id DESC`,
      )
      .all(req.params.id);
    res.json({ item, revisions });
  }),
);

/* ================================================================== */
/* Vendors                                                             */
/* ================================================================== */

adminRouter.get(
  '/vendors',
  requirePermission('pricebook.read'),
  ah(async (req, res) => {
    const { limit, offset } = parsePagination(req, 50);
    const q = req.query as any;

    const where: string[] = [];
    const params: any[] = [];
    const term = typeof q.q === 'string' ? q.q.trim() : '';
    if (term) {
      where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ?)');
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    const kind = typeof q.kind === 'string' ? q.kind.trim() : '';
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (q.active !== undefined && q.active !== '' && q.active !== 'all') {
      where.push('active = ?');
      params.push(q.active === '0' || q.active === 'false' ? 0 : 1);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM vendors ${clause}`).get(...params) as any).n ?? 0,
    );
    const rows = getDb()
      .prepare(`SELECT * FROM vendors ${clause} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json(page(rows, total, limit, offset));
  }),
);

const vendorCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['vendor', 'subcontractor']).default('vendor'),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  address: z.string().trim().max(400).nullish(),
  notes: z.string().trim().max(5000).default(''),
  active: z.boolean().default(true),
});

adminRouter.post(
  '/vendors',
  requirePermission('pricebook.write'),
  ah(async (req, res) => {
    const input = parseBody(vendorCreateSchema, req.body);
    const actor = currentUser(req);
    const id = newId('vnd');
    const at = now();
    getDb()
      .prepare(
        `INSERT INTO vendors (id, name, kind, phone, email, address, notes, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.name, input.kind, input.phone ?? null, input.email ?? null,
        input.address ?? null, input.notes, input.active ? 1 : 0, at, at,
      );
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'vendor.created',
      entityType: 'vendor',
      entityId: id,
      summary: `Created vendor "${input.name}"`,
      after: { name: input.name, kind: input.kind },
    });
    res.status(201).json({ row: getDb().prepare('SELECT * FROM vendors WHERE id = ?').get(id) });
  }),
);

const vendorPatchSchema = vendorCreateSchema.partial();

adminRouter.patch(
  '/vendors/:id',
  requirePermission('pricebook.write'),
  ah(async (req, res) => {
    const input = parseBody(vendorPatchSchema, req.body);
    const actor = currentUser(req);
    const db = getDb();
    const before = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id) as any;
    if (!before) throw notFound('Vendor not found.');

    const patch: any = {
      name: input.name ?? before.name,
      kind: input.kind ?? before.kind,
      phone: input.phone === undefined ? before.phone : input.phone,
      email: input.email === undefined ? before.email : input.email,
      address: input.address === undefined ? before.address : input.address,
      notes: input.notes ?? before.notes,
      active: input.active === undefined ? before.active : input.active ? 1 : 0,
    };
    db.prepare(
      `UPDATE vendors SET name = @name, kind = @kind, phone = @phone, email = @email,
         address = @address, notes = @notes, active = @active, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, updated_at: now(), id: before.id });

    const after = db.prepare('SELECT * FROM vendors WHERE id = ?').get(before.id);
    audit({
      actorId: actor.id,
      actorName: actor.name,
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: String(before.id),
      summary: `Updated vendor "${before.name}"`,
      before,
      after,
    });
    res.json({ row: after });
  }),
);

/* ================================================================== */
/* Margin floor / commission / tax settings                            */
/* ================================================================== */

const MARGIN_FLOOR_DEFAULT = { default: 15, by_trade: {} as Record<string, number> };
const COMMISSION_DEFAULT = { default_pct: 10 };
const TAX_DEFAULT = { default_rate: 8.5 };

adminRouter.get(
  '/margin-floor',
  requirePermission('bid.read'),
  ah(async (_req, res) => {
    res.json({
      marginFloor: readSetting('margin_floor', MARGIN_FLOOR_DEFAULT),
      commission: readSetting('commission', COMMISSION_DEFAULT),
      tax: readSetting('tax', TAX_DEFAULT),
    });
  }),
);

const marginFloorSchema = z.object({
  default: z.number().min(0).max(100),
  by_trade: z.record(z.number().min(0).max(100)),
  commission: z.object({ default_pct: z.number().min(0).max(100) }).optional(),
  tax: z.object({ default_rate: z.number().min(0).max(100) }).optional(),
});

adminRouter.put(
  '/margin-floor',
  requirePermission('settings.manage'),
  ah(async (req, res) => {
    const input = parseBody(marginFloorSchema, req.body);
    const actor = currentUser(req);

    const writes: Array<{ key: string; value: unknown }> = [
      { key: 'margin_floor', value: { default: input.default, by_trade: input.by_trade } },
    ];
    if (input.commission) writes.push({ key: 'commission', value: input.commission });
    if (input.tax) writes.push({ key: 'tax', value: input.tax });

    tx((db) => {
      for (const w of writes) {
        // Read the previous value FIRST — the audit row must capture what
        // the setting was before this write.
        const prev = db.prepare('SELECT value FROM settings WHERE key = ?').get(w.key) as
          | { value: string }
          | undefined;
        let before: unknown = null;
        if (prev) {
          try {
            before = JSON.parse(prev.value);
          } catch {
            before = prev.value;
          }
        }
        db.prepare(
          `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).run(w.key, JSON.stringify(w.value), actor.id, now());

        audit({
          actorId: actor.id,
          actorName: actor.name,
          action: 'settings.updated',
          entityType: 'settings',
          entityId: w.key,
          summary: `Updated setting "${w.key}"`,
          before,
          after: w.value,
        });
      }
    });

    res.json({
      marginFloor: readSetting('margin_floor', MARGIN_FLOOR_DEFAULT),
      commission: readSetting('commission', COMMISSION_DEFAULT),
      tax: readSetting('tax', TAX_DEFAULT),
    });
  }),
);

/* ================================================================== */
/* Demo data & integration status                                      */
/* ================================================================== */

adminRouter.get(
  '/demo-data-status',
  ah(async (_req, res) => {
    res.json({ demoData: readSetting('demo_data', false) });
  }),
);

/**
 * Honest provider status. `configured` is true ONLY when both the provider
 * env var and the API key are non-empty — nothing here claims a provider is
 * live on the strength of one of the two. `forceTestMode` mirrors the
 * communications kill switch for SMS/email; e-sign and payments stay in test
 * mode unconditionally because this build ships no integration code for them.
 */
adminRouter.get(
  '/integrations',
  ah(async (_req, res) => {
    const env = (name: string): string => (process.env[name] ?? '').trim();
    const comm = readSetting<{ provider?: string; force_test_mode?: boolean }>('communications', {});
    const commProvider = (comm.provider ?? '').trim();
    const forceTestMode = comm.force_test_mode !== false;

    const smsProvider = env('SMS_PROVIDER') || commProvider || 'none';
    const emailProvider = env('EMAIL_PROVIDER') || commProvider || 'none';
    const esignProvider = env('ESIGN_PROVIDER') || 'none';
    const paymentsProvider = env('PAYMENTS_PROVIDER') || 'none';

    res.json({
      sms: {
        provider: smsProvider,
        configured: Boolean(env('SMS_PROVIDER') && env('SMS_API_KEY')),
        forceTestMode,
      },
      email: {
        provider: emailProvider,
        configured: Boolean(env('EMAIL_PROVIDER') && env('EMAIL_API_KEY')),
        forceTestMode,
      },
      esign: {
        provider: esignProvider,
        configured: Boolean(env('ESIGN_PROVIDER') && env('ESIGN_API_KEY')),
        forceTestMode: true,
      },
      payments: {
        provider: paymentsProvider,
        configured: Boolean(env('PAYMENTS_PROVIDER') && env('PAYMENTS_API_KEY')),
        forceTestMode: true,
      },
    });
  }),
);
