import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, patch, post, put, qs } from '../../lib/api';
import { useAction, useDebounced, useFetch } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { ROLE_LABELS } from '../../lib/permissions';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  FormActions,
  Input,
  KeyValue,
  Loading,
  Modal,
  PageHead,
  Segmented,
  Select,
  Tabs,
  type Tone,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateTime, money2, num, rel, titleCase } from '../../lib/format';

type Section = 'users' | 'roles' | 'pricing' | 'dispositions' | 'integrations' | 'audit';

const SECTION_TABS: Array<{ key: Section; label: string }> = [
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'dispositions', label: 'Dispositions' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'audit', label: 'Audit' },
];

const DAY_MS = 86_400_000;

interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface FetchState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

interface RosterRow {
  id: string;
  name: string;
  email: string;
  role_key: string;
  active: number;
  last_login_at?: number | null;
}

function is403(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/** 403s explain the gate instead of showing a scary error. */
function PermissionCallout({ permission, children }: { permission: string; children?: ReactNode }) {
  return (
    <Callout tone="grey">
      {children ?? (
        <>
          This section requires the <b>{permission}</b> permission.
        </>
      )}{' '}
      The server refuses this request for your role, so the data is not shown rather than surfaced as an
      error.
    </Callout>
  );
}

function actionTone(action: string): Tone {
  const a = action.toLowerCase();
  if (a.includes('fail') || a.includes('delete') || a.includes('deactivat') || a.includes('logout')) return 'red';
  if (a.includes('created') || a.includes('login') || a.includes('approve') || a.includes('authoriz')) return 'green';
  if (a.includes('updated') || a.includes('changed') || a.includes('moved') || a.includes('stage')) return 'blue';
  return 'neutral';
}

/** 'YYYY-MM-DD' → epoch ms of local start (or end) of that day. */
function dayStart(v: string): number | null {
  if (!v) return null;
  const parts = v.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
}
function dayEnd(v: string): number | null {
  const s = dayStart(v);
  return s === null ? null : s + DAY_MS - 1;
}

function Pager({
  total,
  limit,
  offset,
  loading,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  loading?: boolean;
  onChange: (offset: number) => void;
}) {
  if (!total) return null;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <span className="tiny muted">
        {num(offset + 1)}–{num(Math.min(offset + limit, total))} of {num(total)}
      </span>
      <span className="spacer" />
      <Button size="sm" disabled={offset === 0 || !!loading} onClick={() => onChange(Math.max(0, offset - limit))}>
        Prev
      </Button>
      <Button
        size="sm"
        disabled={offset + limit >= total || !!loading}
        onClick={() => onChange(offset + limit)}
      >
        Next
      </Button>
    </div>
  );
}

export default function AdminPage() {
  const [section, setSection] = useState<Section>('users');
  const roster = useFetch<{ rows: RosterRow[] }>('/auth/roster');

  return (
    <>
      <PageHead
        title="Admin"
        sub="Users, roles, pricing, workflow configuration and the append-only audit trail."
      />
      <Tabs tabs={SECTION_TABS} active={section} onChange={(k) => setSection(k as Section)} />

      {section === 'users' ? <UsersSection roster={roster} /> : null}
      {section === 'roles' ? <RolesSection /> : null}
      {section === 'pricing' ? <PricingSection /> : null}
      {section === 'dispositions' ? <DispositionsSection /> : null}
      {section === 'integrations' ? <IntegrationsSection /> : null}
      {section === 'audit' ? <AuditSection roster={roster} /> : null}
    </>
  );
}

/* ================================================================== */
/* Users                                                               */
/* ================================================================== */

function UsersSection({ roster }: { roster: FetchState<{ rows: RosterRow[] }> }) {
  const { roleCatalog } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RosterRow | null>(null);
  const rows = roster.data?.rows ?? [];

  let body: ReactNode;
  if (roster.error && !roster.data) {
    body = <ErrorState error={roster.error} onRetry={roster.reload} />;
  } else if (roster.loading && !roster.data) {
    body = <Loading label="Loading roster…" />;
  } else if (rows.length === 0) {
    body = (
      <EmptyState title="No accounts yet." icon={<Icon name="contacts" size={22} />}>
        Add the first user to give someone a sign-in.
      </EmptyState>
    );
  } else {
    body = (
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.name}</td>
                <td className="muted">{r.email}</td>
                <td>
                  <Badge tone="accent">{roleCatalog[r.role_key]?.name ?? titleCase(r.role_key)}</Badge>
                </td>
                <td>{r.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}</td>
                <td className="muted small">{rel(r.last_login_at ?? null)}</td>
                <td className="right">
                  <Button size="sm" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <Card
        title="Users"
        sub={`${num(rows.length)} account${rows.length === 1 ? '' : 's'} on the roster`}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Icon name="plus" size={14} />}
            onClick={() => setCreating(true)}
          >
            Add user
          </Button>
        }
      >
        {roster.error && roster.data ? <ErrorState error={roster.error} onRetry={roster.reload} /> : null}
        {body}
      </Card>

      {creating ? (
        <UserDialog
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            roster.reload();
          }}
        />
      ) : null}
      {editing ? (
        <UserDialog
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            roster.reload();
          }}
        />
      ) : null}
    </>
  );
}

function roleOptions(roleCatalog: Record<string, { name: string; description: string }>) {
  const fromServer = Object.entries(roleCatalog).map(([key, v]) => ({ key, name: v.name }));
  // Static mirror of the server catalog, used only if /auth/me has not loaded.
  return fromServer.length
    ? fromServer
    : Object.entries(ROLE_LABELS).map(([key, name]) => ({ key, name }));
}

function UserDialog({
  mode,
  row,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  row?: RosterRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { roleCatalog } = useAuth();
  const roles = roleOptions(roleCatalog);
  const [name, setName] = useState(row?.name ?? '');
  const [email, setEmail] = useState(row?.email ?? '');
  const [role, setRole] = useState(row?.role_key ?? roles[0]?.key ?? '');
  const [password, setPassword] = useState('');
  const [active, setActive] = useState(row ? row.active !== 0 : true);

  const action = useAction(async () => {
    if (mode === 'create') {
      return post('/auth/users', { email: email.trim(), name: name.trim(), role, password });
    }
    const body: Record<string, unknown> = { name: name.trim(), role, active };
    if (password) body.password = password;
    return patch(`/auth/users/${row!.id}`, body);
  });

  const submit = async () => {
    const res = await action.run();
    if (res !== undefined) {
      toast.success(mode === 'create' ? 'User created' : 'User updated');
      onSaved();
    }
    // Otherwise the server's message is rendered inside the dialog.
  };

  const fe = (action.error?.fieldErrors ?? {}) as Record<string, string>;
  const pwTooShort = password.length > 0 && password.length < 8;
  const invalid =
    !name.trim() || !role || (mode === 'create' && (!email.trim() || password.length < 8)) || pwTooShort;

  return (
    <Modal
      title={mode === 'create' ? 'Add user' : `Edit ${row?.name ?? 'user'}`}
      sub={mode === 'create' ? 'The account can sign in immediately.' : row?.email}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.pending} disabled={invalid} onClick={submit}>
            {mode === 'create' ? 'Create user' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        {mode === 'create' ? (
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={fe.email}
          />
        ) : null}
        <Input
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fe.name}
        />
        <Select
          label="Role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value)}
          options={roles.map((r) => ({ value: r.key, label: r.name }))}
          error={fe.role}
        />
        <Input
          label={mode === 'create' ? 'Password' : 'New password'}
          type="password"
          required={mode === 'create'}
          minLength={8}
          hint={mode === 'create' ? 'Minimum 8 characters.' : 'Leave empty to keep the current password.'}
          error={pwTooShort ? 'Passwords must be at least 8 characters.' : fe.password}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'edit' ? (
          <Checkbox
            label="Active"
            hint="Inactive accounts cannot sign in. The server refuses deactivating your own account."
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Roles                                                               */
/* ================================================================== */

interface RolesResponse {
  roles: Record<string, { name: string; description: string }>;
  permissions: Record<string, string>;
  rolePermissions: Record<string, string[]>;
  userCounts: Record<string, number>;
}

function RolesSection() {
  const res = useFetch<RolesResponse>('/admin/roles');

  if (res.error && !res.data) {
    if (is403(res.error)) return <PermissionCallout permission="admin.manage" />;
    return <ErrorState error={res.error} onRetry={res.reload} />;
  }
  if (res.loading && !res.data) return <Loading label="Loading roles…" />;
  const d = res.data!;
  const roleKeys = Object.keys(d.roles ?? {});
  const permKeys = Object.keys(d.permissions ?? {});

  return (
    <div className="stack">
      <Callout tone="blue">
        Roles are enforced on the server for every request. This matrix is a reference view, not the control.
      </Callout>
      <Card
        title="Role × permission matrix"
        sub={`${num(permKeys.length)} permissions · ${num(roleKeys.length)} roles · live active-user counts`}
      >
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Permission</th>
                {roleKeys.map((rk) => (
                  <th key={rk} style={{ textAlign: 'center' }}>
                    <div className="col" style={{ gap: 2, alignItems: 'center' }}>
                      <span className="small strong">{d.roles[rk].name}</span>
                      <span className="tiny muted">{num(d.userCounts?.[rk] ?? 0)} active</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permKeys.map((pk) => (
                <tr key={pk}>
                  <td>
                    <div className="mono tiny">{pk}</div>
                    <div className="tiny muted">{d.permissions[pk]}</div>
                  </td>
                  {roleKeys.map((rk) => {
                    const granted = (d.rolePermissions?.[rk] ?? []).includes(pk);
                    return (
                      <td key={rk} style={{ textAlign: 'center' }} title={granted ? 'Granted' : 'Not granted'}>
                        <span className={granted ? 'strong' : 'muted'}>{granted ? '✓' : '–'}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ================================================================== */
/* Pricing: price book, vendors, margin floor                          */
/* ================================================================== */

interface PriceItem {
  id: string;
  code: string;
  name: string;
  vendor_id: string | null;
  vendor_name?: string | null;
  unit: string;
  price: number;
  tax_class: string;
  protected: number;
  active: number;
}

interface Vendor {
  id: string;
  name: string;
  kind: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  active: number;
}

interface MarginFloorResponse {
  marginFloor: { default: number; by_trade: Record<string, number> };
  commission: { default_pct: number };
  tax: { default_rate: number };
}

function PricingSection() {
  const { can } = useAuth();
  const canRead = can('pricebook.read');
  const canWrite = can('pricebook.write');
  const canEditFloor = can('settings.manage');

  const [tab, setTab] = useState<'items' | 'vendors'>('items');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [dq]);

  const items = useFetch<Page<PriceItem>>(
    canRead ? `/admin/price-book?${qs({ q: dq, limit: 25, offset })}` : null,
    [canRead, dq, offset],
  );
  const vendors = useFetch<Page<Vendor>>(canRead ? `/admin/vendors?${qs({ limit: 200 })}` : null, [canRead]);
  const floor = useFetch<MarginFloorResponse>(can('bid.read') ? '/admin/margin-floor' : null, []);

  const [creatingItem, setCreatingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<PriceItem | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);

  const vendorRows = vendors.data?.rows ?? [];
  const itemRows = items.data?.rows ?? [];
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));

  const itemsBody = !canRead ? (
    <PermissionCallout permission="pricebook.read" />
  ) : items.error && is403(items.error) && !items.data ? (
    <PermissionCallout permission="pricebook.read" />
  ) : items.error && !items.data ? (
    <ErrorState error={items.error} onRetry={items.reload} />
  ) : items.loading && !items.data ? (
    <Loading label="Loading price book…" />
  ) : itemRows.length === 0 ? (
    <EmptyState title="No price book items." icon={<Icon name="dollar" size={22} />}>
      {dq ? 'Nothing matches this search.' : 'Add the first item to give estimating real unit prices.'}
    </EmptyState>
  ) : (
    <>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Vendor</th>
              <th>Unit</th>
              <th className="num">Price</th>
              <th>Tax class</th>
              <th>Flags</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {itemRows.map((item) => (
              <tr key={item.id}>
                <td className="mono small">{item.code}</td>
                <td className="strong">{item.name}</td>
                <td className="muted">{item.vendor_name ?? '—'}</td>
                <td className="mono tiny">{item.unit || '—'}</td>
                <td className="num">{money2(item.price)}</td>
                <td className="small">{titleCase(item.tax_class)}</td>
                <td>
                  <div className="row">
                    {item.protected === 1 ? <Badge tone="violet">Protected</Badge> : null}
                    {item.active === 1 ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
                  </div>
                </td>
                <td className="right nowrap">
                  <Button size="sm" onClick={() => setHistoryId(item.id)}>
                    History
                  </Button>{' '}
                  {canWrite ? (
                    <Button size="sm" onClick={() => setEditingItem(item)}>
                      Edit
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        total={items.data?.total ?? 0}
        limit={items.data?.limit ?? 25}
        offset={items.data?.offset ?? offset}
        loading={items.loading}
        onChange={setOffset}
      />
    </>
  );

  const vendorsBody = !canRead ? (
    <PermissionCallout permission="pricebook.read" />
  ) : vendors.error && !vendors.data ? (
    <ErrorState error={vendors.error} onRetry={vendors.reload} />
  ) : vendors.loading && !vendors.data ? (
    <Loading label="Loading vendors…" />
  ) : vendorRows.length === 0 ? (
    <EmptyState title="No vendors." icon={<Icon name="companies" size={22} />}>
      Add a vendor so price book items can be attributed to a supplier.
    </EmptyState>
  ) : (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vendorRows.map((v) => (
            <tr key={v.id}>
              <td className="strong">{v.name}</td>
              <td className="small">{titleCase(v.kind)}</td>
              <td className="small mono">{v.phone || '—'}</td>
              <td className="small muted">{v.email || '—'}</td>
              <td>{v.active ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
              <td className="right">
                {canWrite ? (
                  <Button size="sm" onClick={() => setEditingVendor(v)}>
                    Edit
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="stack">
      <Segmented
        options={[
          { value: 'items', label: 'Price book' },
          { value: 'vendors', label: 'Vendors' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'items' ? (
        <Card
          title="Price book"
          sub="Unit prices used by estimating. Codes are unique — duplicates are refused with a 409."
          actions={
            <>
              <Input
                placeholder="Search code or name…"
                aria-label="Search price book"
                className="input-sm"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {canWrite ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Icon name="plus" size={14} />}
                  onClick={() => setCreatingItem(true)}
                >
                  New item
                </Button>
              ) : null}
            </>
          }
        >
          {itemsBody}
        </Card>
      ) : (
        <Card
          title="Vendors"
          sub="Suppliers and subcontractors referenced by price book items."
          actions={
            canWrite ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Icon name="plus" size={14} />}
                onClick={() => setCreatingVendor(true)}
              >
                New vendor
              </Button>
            ) : null
          }
        >
          {vendorsBody}
        </Card>
      )}

      {floor.error && is403(floor.error) && !floor.data ? (
        <PermissionCallout permission="bid.read" />
      ) : floor.error && !floor.data ? (
        <ErrorState error={floor.error} onRetry={floor.reload} />
      ) : floor.loading && !floor.data ? (
        <Loading label="Loading margin floor…" />
      ) : floor.data ? (
        <MarginFloorCard data={floor.data} canEdit={canEditFloor} onSaved={floor.reload} />
      ) : null}

      {creatingItem ? (
        <PriceItemDialog
          mode="create"
          vendors={vendorRows}
          onClose={() => setCreatingItem(false)}
          onSaved={() => {
            setCreatingItem(false);
            items.reload();
          }}
        />
      ) : null}
      {editingItem ? (
        <PriceItemDialog
          mode="edit"
          row={editingItem}
          vendors={vendorRows}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            items.reload();
          }}
        />
      ) : null}
      {historyId ? <HistoryDialog itemId={historyId} onClose={() => setHistoryId(null)} /> : null}
      {creatingVendor ? (
        <VendorDialog
          mode="create"
          onClose={() => setCreatingVendor(false)}
          onSaved={() => {
            setCreatingVendor(false);
            vendors.reload();
            items.reload();
          }}
        />
      ) : null}
      {editingVendor ? (
        <VendorDialog
          mode="edit"
          row={editingVendor}
          onClose={() => setEditingVendor(null)}
          onSaved={() => {
            setEditingVendor(null);
            vendors.reload();
            items.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function PriceItemDialog({
  mode,
  row,
  vendors,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  row?: PriceItem;
  vendors: Vendor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [unit, setUnit] = useState(row?.unit ?? 'EA');
  const [price, setPrice] = useState(row ? String(row.price) : '');
  const [taxClass, setTaxClass] = useState(row?.tax_class ?? 'taxable');
  const [vendorId, setVendorId] = useState(row?.vendor_id ?? '');
  const [isProtected, setIsProtected] = useState(row ? row.protected === 1 : false);
  const [active, setActive] = useState(row ? row.active === 1 : true);
  const [note, setNote] = useState('');

  const protectedLocked = !!row && row.protected === 1 && !can('pricebook.protected_write');

  const action = useAction(async () => {
    if (mode === 'create') {
      return post('/admin/price-book', {
        code: code.trim(),
        name: name.trim(),
        price: Number(price),
        unit: unit.trim() || 'EA',
        taxClass,
        vendorId: vendorId || undefined,
        protected: isProtected,
      });
    }
    return patch(`/admin/price-book/${row!.id}`, {
      name: name.trim(),
      price: Number(price),
      taxClass,
      unit: unit.trim() || 'EA',
      vendorId: vendorId || null,
      active,
      note: note.trim(),
    });
  });

  const submit = async () => {
    const res = await action.run();
    if (res !== undefined) {
      toast.success(mode === 'create' ? 'Price book item created' : 'Price book item updated');
      onSaved();
    }
  };

  const priceBad = price.trim() === '' || !Number.isFinite(Number(price)) || Number(price) < 0;
  const invalid = !name.trim() || priceBad || (mode === 'create' && !code.trim());
  const err = action.error;
  const duplicate = err instanceof ApiError && err.status === 409;

  return (
    <Modal
      title={mode === 'create' ? 'New price book item' : `Edit ${row?.code ?? 'item'}`}
      sub={mode === 'edit' ? row?.name : 'Codes must be unique across the book.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.pending} disabled={invalid} onClick={submit}>
            {mode === 'create' ? 'Create item' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {/* 403 → warn-state (names the permission); 409 → duplicate code; everything else → error-state. */}
        {err ? (
          err.status === 403 ? (
            <div className="warn-state" role="alert">
              {err.message}
            </div>
          ) : (
            <div className="error-state" role="alert">
              {err.message}
              {duplicate ? ' Pick another code or edit the existing item.' : ''}
            </div>
          )
        ) : null}
        <div className="form-grid">
          <Input
            label="Code"
            required
            disabled={mode === 'edit'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={err?.fieldErrors?.code}
          />
          <Input
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={err?.fieldErrors?.name}
          />
          <Input
            label="Unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            hint="e.g. EA, SQ, LF"
            error={err?.fieldErrors?.unit}
          />
          <Input
            label="Price"
            type="number"
            min={0}
            step={0.01}
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={priceBad && price !== '' ? 'Enter a non-negative number.' : err?.fieldErrors?.price}
          />
          <Select
            label="Tax class"
            value={taxClass}
            onChange={(e) => setTaxClass(e.target.value)}
            options={[
              { value: 'taxable', label: 'Taxable' },
              { value: 'exempt', label: 'Exempt' },
            ]}
          />
          <Select
            label="Vendor"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            placeholder="No vendor"
            options={vendors.map((v) => ({ value: v.id, label: v.name }))}
          />
        </div>

        {mode === 'create' ? (
          <Checkbox
            label="Protected price"
            hint="Protected items need the pricebook.protected_write permission before their price or tax class can change."
            checked={isProtected}
            onChange={(e) => setIsProtected(e.target.checked)}
          />
        ) : (
          <div className="row wrap">
            {row?.protected === 1 ? <Badge tone="violet">Protected</Badge> : <Badge tone="neutral">Unprotected</Badge>}
            <span className="tiny muted">
              {protectedLocked
                ? 'Changing price or tax class requires pricebook.protected_write.'
                : 'Name, unit, vendor and active state can always be edited.'}
            </span>
          </div>
        )}

        {mode === 'edit' ? (
          <>
            <Checkbox
              label="Active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <Input
              label="Change note"
              value={note}
              placeholder="Why is this changing?"
              hint="Recorded in the audit trail alongside the revision."
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        ) : null}
      </div>
    </Modal>
  );
}

interface Revision {
  id: string;
  price: number;
  tax_class: string;
  effective_from?: number | null;
  changed_at: number;
  changed_by_name?: string | null;
  note?: string | null;
}

function HistoryDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const res = useFetch<{ item: PriceItem; revisions: Revision[] }>(`/admin/price-book/${itemId}/history`);
  const revisions = res.data?.revisions ?? [];

  return (
    <Modal
      title="Price history"
      sub={res.data ? `${res.data.item.code} · ${res.data.item.name}` : 'Loading…'}
      size="lg"
      onClose={onClose}
    >
      {res.error && !res.data ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : res.loading && !res.data ? (
        <Loading label="Loading history…" />
      ) : revisions.length === 0 ? (
        <EmptyState title="No revisions recorded." icon={<Icon name="clock" size={22} />}>
          Revisions are appended whenever the price or tax class changes.
        </EmptyState>
      ) : (
        <div className="list">
          {revisions.map((r) => (
            <div className="list-item" key={r.id}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap">
                  <b className="num">{money2(r.price)}</b>
                  <Badge tone="outline">{titleCase(r.tax_class)}</Badge>
                  <span className="tiny muted">{dateTime(r.changed_at)}</span>
                </div>
                <div className="tiny muted truncate">
                  by {r.changed_by_name || '—'}
                  {r.note ? ` · ${r.note}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function VendorDialog({
  mode,
  row,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  row?: Vendor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(row?.name ?? '');
  const [kind, setKind] = useState(row?.kind ?? 'vendor');
  const [phone, setPhone] = useState(row?.phone ?? '');
  const [email, setEmail] = useState(row?.email ?? '');
  const [notes, setNotes] = useState(row?.notes ?? '');

  const action = useAction(async () => {
    if (mode === 'create') {
      return post('/admin/vendors', {
        name: name.trim(),
        kind,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim(),
      });
    }
    return patch(`/admin/vendors/${row!.id}`, {
      name: name.trim(),
      kind,
      phone: phone.trim() || null,
      email: email.trim() || null,
      notes: notes.trim(),
    });
  });

  const submit = async () => {
    const res = await action.run();
    if (res !== undefined) {
      toast.success(mode === 'create' ? 'Vendor created' : 'Vendor updated');
      onSaved();
    }
  };

  return (
    <Modal
      title={mode === 'create' ? 'New vendor' : `Edit ${row?.name ?? 'vendor'}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.pending}
            disabled={!name.trim()}
            onClick={submit}
          >
            {mode === 'create' ? 'Create vendor' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Input
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={action.error?.fieldErrors?.name}
        />
        <Select
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          options={[
            { value: 'vendor', label: 'Vendor' },
            { value: 'subcontractor', label: 'Subcontractor' },
          ]}
        />
        <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  );
}

function MarginFloorCard({
  data,
  canEdit,
  onSaved,
}: {
  data: MarginFloorResponse;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [def, setDef] = useState(String(data.marginFloor?.default ?? ''));
  const [trades, setTrades] = useState(() =>
    Object.entries(data.marginFloor?.by_trade ?? {}).map(([trade, pctValue]) => ({
      trade,
      pct: String(pctValue),
    })),
  );
  const [commission, setCommission] = useState(String(data.commission?.default_pct ?? ''));
  const [tax, setTax] = useState(String(data.tax?.default_rate ?? ''));

  const action = useAction(() =>
    put('/admin/margin-floor', {
      default: Number(def),
      by_trade: Object.fromEntries(
        trades
          .filter((t) => t.trade.trim())
          .map((t) => [t.trade.trim(), Number(t.pct)]),
      ),
      commission: { default_pct: Number(commission) },
      tax: { default_rate: Number(tax) },
    }),
  );

  const bad = (v: string) => v.trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 100;
  const invalid =
    bad(def) || bad(commission) || bad(tax) || trades.some((t) => !t.trade.trim() || bad(t.pct));

  const update = (i: number, field: 'trade' | 'pct', value: string) =>
    setTrades((prev) => prev.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)));

  const save = async () => {
    const res = await action.run();
    if (res !== undefined) {
      toast.success('Margin floor saved');
      onSaved();
    }
  };

  return (
    <Card title="Margin floor, commission & tax" sub="Global pricing settings.">
      <div className="stack">
        <Callout tone="grey">
          The margin floor is the lowest margin a released quote may carry: a quote priced below its floor
          can only go out once an approved margin exception exists — the gate runs on the server, not here.
          Trade rows override the default for that trade.
        </Callout>

        <div className="form-grid">
          <Input
            label="Default floor %"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={def}
            onChange={(e) => setDef(e.target.value)}
            error={bad(def) ? 'Enter a percentage between 0 and 100.' : undefined}
          />
          <Input
            label="Commission default %"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
            error={bad(commission) ? 'Enter a percentage between 0 and 100.' : undefined}
          />
          <Input
            label="Tax default %"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            error={bad(tax) ? 'Enter a percentage between 0 and 100.' : undefined}
          />
        </div>

        <div className="col" style={{ gap: 6 }}>
          <div className="row">
            <span className="small strong grow">Per-trade floors</span>
            <Button
              size="sm"
              icon={<Icon name="plus" size={14} />}
              onClick={() => setTrades((prev) => [...prev, { trade: '', pct: '' }])}
            >
              Add trade
            </Button>
          </div>
          {trades.length === 0 ? (
            <div className="tiny muted">No trade overrides — the default applies to every trade.</div>
          ) : (
            trades.map((t, i) => (
              <div className="row" key={i}>
                <Input
                  className="input-sm"
                  placeholder="Trade (e.g. roofing)"
                  aria-label="Trade"
                  value={t.trade}
                  onChange={(e) => update(i, 'trade', e.target.value)}
                />
                <Input
                  className="input-sm"
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  placeholder="Floor %"
                  aria-label="Trade floor percent"
                  style={{ maxWidth: 110 }}
                  value={t.pct}
                  onChange={(e) => update(i, 'pct', e.target.value)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="x" size={14} />}
                  aria-label={`Remove ${t.trade || 'row'}`}
                  onClick={() => setTrades((prev) => prev.filter((_, idx) => idx !== i))}
                />
              </div>
            ))
          )}
        </div>

        {action.error ? (
          action.error.status === 403 ? (
            <div className="warn-state" role="alert">
              {action.error.message}
            </div>
          ) : (
            <div className="error-state" role="alert">
              {action.error.message}
            </div>
          )
        ) : null}

        <FormActions>
          <Button
            variant="primary"
            loading={action.pending}
            disabled={invalid || !canEdit}
            title={canEdit ? undefined : 'Requires the settings.manage permission.'}
            onClick={save}
          >
            Save floor settings
          </Button>
        </FormActions>
      </div>
    </Card>
  );
}

/* ================================================================== */
/* Dispositions                                                        */
/* ================================================================== */

interface Disposition {
  id: string;
  workspace: 'prospect' | 'bid';
  key: string;
  name: string;
  active: number;
  sort: number;
}

function DispositionsSection() {
  const { can } = useAuth();
  const config = useFetch<{ dispositions: Disposition[] }>('/config');
  const [creatingWs, setCreatingWs] = useState<'prospect' | 'bid' | null>(null);
  const canEdit = can('settings.manage');
  const rows = config.data?.dispositions ?? [];

  if (config.error && !config.data) {
    if (is403(config.error)) return <PermissionCallout permission="settings.manage" />;
    return <ErrorState error={config.error} onRetry={config.reload} />;
  }
  if (config.loading && !config.data) return <Loading label="Loading dispositions…" />;

  const column = (ws: 'prospect' | 'bid', title: string) => {
    const list = rows.filter((d) => d.workspace === ws);
    return (
      <Card
        title={title}
        sub={`${num(list.length)} disposition${list.length === 1 ? '' : 's'}`}
        actions={
          canEdit ? (
            <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setCreatingWs(ws)}>
              New disposition
            </Button>
          ) : null
        }
      >
        {list.length === 0 ? (
          <EmptyState title="No dispositions yet." icon={<Icon name="filter" size={22} />}>
            Add one so reps can record outcomes consistently.
          </EmptyState>
        ) : (
          <div className="list">
            {list.map((d) => (
              <DispositionRow key={d.id} row={d} canEdit={canEdit} onSaved={config.reload} />
            ))}
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="stack">
      <Callout tone="grey">
        Rows are never deleted so historical records keep a valid reference. Deactivate instead — renames,
        deactivations and sort order are the only edits available.
      </Callout>
      <div className="grid grid-2">
        {column('prospect', 'Prospect')}
        {column('bid', 'Bid')}
      </div>

      {creatingWs ? (
        <NewDispositionDialog
          workspace={creatingWs}
          onClose={() => setCreatingWs(null)}
          onSaved={() => {
            setCreatingWs(null);
            config.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function DispositionRow({
  row,
  canEdit,
  onSaved,
}: {
  row: Disposition;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(row.name);
  const [sort, setSort] = useState(String(row.sort ?? 0));
  const [active, setActive] = useState(row.active === 1);
  const [pending, setPending] = useState(false);

  const save = async (body: Record<string, unknown>) => {
    setPending(true);
    try {
      await patch(`/config/dispositions/${row.id}`, body);
      toast.success('Disposition updated');
      onSaved();
    } catch (err) {
      toast.error('Could not update disposition', err instanceof Error ? err.message : undefined);
    } finally {
      setPending(false);
    }
  };

  const saveName = () => {
    const v = name.trim();
    if (v && v !== row.name) void save({ name: v });
    else setName(row.name);
  };
  const saveSort = () => {
    const n = Number(sort);
    if (Number.isFinite(n) && n >= 0 && n !== Number(row.sort ?? 0)) void save({ sort: n });
    else setSort(String(row.sort ?? 0));
  };

  return (
    <div className="list-item">
      <Input
        className="input-sm grow"
        aria-label="Disposition name"
        value={name}
        disabled={!canEdit || pending}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveName();
        }}
      />
      <span className="mono tiny nowrap" style={{ width: 120 }} title="Key — immutable">
        {row.key}
      </span>
      <Input
        className="input-sm"
        type="number"
        min={0}
        max={9999}
        aria-label="Sort order"
        style={{ width: 72 }}
        value={sort}
        disabled={!canEdit || pending}
        onChange={(e) => setSort(e.target.value)}
        onBlur={saveSort}
      />
      <Checkbox
        label="Active"
        checked={active}
        disabled={!canEdit || pending}
        title={canEdit ? undefined : 'Requires settings.manage'}
        onChange={(e) => {
          setActive(e.target.checked);
          void save({ active: e.target.checked });
        }}
      />
    </div>
  );
}

function NewDispositionDialog({
  workspace,
  onClose,
  onSaved,
}: {
  workspace: 'prospect' | 'bid';
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');

  const action = useAction(() =>
    post('/config/dispositions', {
      workspace,
      name: name.trim(),
      key: key.trim() || undefined,
    }),
  );

  const submit = async () => {
    const res = await action.run();
    if (res !== undefined) {
      toast.success('Disposition created');
      onSaved();
    }
  };

  return (
    <Modal
      title={`New ${workspace} disposition`}
      sub="Rows are append-only — this one can be renamed or deactivated later, never deleted."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={action.pending} disabled={!name.trim()} onClick={submit}>
            Create disposition
          </Button>
        </>
      }
    >
      <div className="stack">
        {action.error ? (
          <div className="error-state" role="alert">
            {action.error.message}
          </div>
        ) : null}
        <Input
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={action.error?.fieldErrors?.name}
        />
        <Input
          label="Key"
          value={key}
          placeholder="derived_from_name"
          hint="Optional. Lowercase letters, numbers and underscores. Defaults from the name."
          onChange={(e) => setKey(e.target.value)}
          error={action.error?.fieldErrors?.key}
        />
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Integrations                                                        */
/* ================================================================== */

interface IntegrationStatus {
  provider: string;
  configured: boolean;
  forceTestMode: boolean;
}
interface IntegrationsResponse {
  sms: IntegrationStatus;
  email: IntegrationStatus;
  esign: IntegrationStatus;
  payments: IntegrationStatus;
}

const INTEGRATION_CARDS: Array<{ key: keyof IntegrationsResponse; label: string; blurb: string }> = [
  { key: 'sms', label: 'SMS', blurb: 'Outbound texts from call queues and drip steps.' },
  { key: 'email', label: 'Email', blurb: 'Templates and drip campaigns.' },
  { key: 'esign', label: 'E-sign', blurb: 'Proposal and contract signatures.' },
  { key: 'payments', label: 'Payments', blurb: 'Deposits and draw collections.' },
];

function IntegrationsSection() {
  const integrations = useFetch<IntegrationsResponse>('/admin/integrations');
  const demo = useFetch<{ demoData: boolean }>('/admin/demo-data-status');
  const data = integrations.data;

  return (
    <div className="stack">
      {demo.data?.demoData ? (
        <div className="warn-state" role="status">
          Demo data is present in this database — do not mistake it for production records.
        </div>
      ) : null}
      {demo.error ? <ErrorState error={demo.error} onRetry={demo.reload} /> : null}

      {integrations.error && !data ? (
        <ErrorState error={integrations.error} onRetry={integrations.reload} />
      ) : integrations.loading && !data ? (
        <Loading label="Loading integration status…" />
      ) : data ? (
        <div className="grid grid-2">
          {INTEGRATION_CARDS.map((c) => {
            const s = data[c.key];
            return (
              <Card key={c.key} title={c.label} sub={c.blurb}>
                <div className="col" style={{ gap: 8 }}>
                  <div className="row wrap">
                    <span className="mono small grow truncate">{s.provider || '—'}</span>
                    <Badge tone={s.configured ? 'green' : 'amber'}>
                      {s.configured ? 'Configured' : 'Not configured'}
                    </Badge>
                  </div>
                  <div className="row wrap">
                    <Badge tone={s.forceTestMode ? 'outline' : 'green'}>
                      {s.forceTestMode ? 'Force test mode' : 'No test-mode override'}
                    </Badge>
                    <span className="tiny muted">
                      {s.configured ? 'Live credentials present.' : 'Drafts only — nothing is delivered.'}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}

      <Callout tone="grey">
        Only a provider with a real API key and a provider name is live; anything else means the app records
        drafts with the intended content but delivers nothing.{' '}
        <a href="docs/integrations.md" target="_blank" rel="noreferrer">
          docs/integrations.md
        </a>
      </Callout>
    </div>
  );
}

/* ================================================================== */
/* Audit                                                               */
/* ================================================================== */

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  before: unknown;
  after: unknown;
  meta: unknown;
  at: number;
}

const AUDIT_LIMIT = 50;

function AuditSection({ roster }: { roster: FetchState<{ rows: RosterRow[] }> }) {
  const { can } = useAuth();
  const canAudit = can('audit.view');
  const [filters, setFilters] = useState({
    entityType: '',
    action: '',
    actorId: '',
    from: '',
    to: '',
    q: '',
  });
  const setF = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const dq = useDebounced(filters.q, 250);
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<AuditRow | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [dq, filters.entityType, filters.action, filters.actorId, filters.from, filters.to]);

  const audit = useFetch<Page<AuditRow>>(
    canAudit
      ? `/admin/audit?${qs({
          entityType: filters.entityType,
          action: filters.action,
          actorId: filters.actorId,
          from: dayStart(filters.from),
          to: dayEnd(filters.to),
          q: dq,
          limit: AUDIT_LIMIT,
          offset,
        })}`
      : null,
    [canAudit, filters.entityType, filters.action, filters.actorId, filters.from, filters.to, dq, offset],
  );

  const rows = audit.data?.rows ?? [];

  let table: ReactNode;
  if (!canAudit) {
    table = <PermissionCallout permission="audit.view" />;
  } else if (audit.error && is403(audit.error) && !audit.data) {
    table = <PermissionCallout permission="audit.view" />;
  } else if (audit.error && !audit.data) {
    table = <ErrorState error={audit.error} onRetry={audit.reload} />;
  } else if (audit.loading && !audit.data) {
    table = <Loading label="Loading audit trail…" />;
  } else if (rows.length === 0) {
    table = (
      <EmptyState title="No audit entries match." icon={<Icon name="file" size={22} />}>
        Widen or clear the filters to see more history.
      </EmptyState>
    );
  } else {
    table = (
      <>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Summary</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap small muted">{dateTime(r.at)}</td>
                  <td className="small">{r.actor_name || '—'}</td>
                  <td>
                    <Badge tone={actionTone(r.action)}>{r.action}</Badge>
                  </td>
                  <td className="small nowrap">
                    <span className="muted">{titleCase(r.entity_type)}</span>{' '}
                    <span className="mono tiny">{r.entity_id}</span>
                  </td>
                  <td className="truncate" title={r.summary}>
                    {r.summary || '—'}
                  </td>
                  <td className="right">
                    <Button size="sm" onClick={() => setView(r)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          total={audit.data?.total ?? 0}
          limit={audit.data?.limit ?? AUDIT_LIMIT}
          offset={audit.data?.offset ?? offset}
          loading={audit.loading}
          onChange={setOffset}
        />
      </>
    );
  }

  return (
    <div className="stack">
      <Callout tone="grey">
        This is the traceability view: entries are append-only, so nothing here can be edited or removed
        through the app — every approval, handoff and pricing decision stays reconstructable.
      </Callout>

      <div className="filters">
        <Input
          className="input-sm"
          placeholder="Entity type…"
          aria-label="Entity type"
          value={filters.entityType}
          onChange={(e) => setF('entityType', e.target.value)}
        />
        <Input
          className="input-sm"
          placeholder="Action…"
          aria-label="Action"
          value={filters.action}
          onChange={(e) => setF('action', e.target.value)}
        />
        <Select
          className="input-sm"
          aria-label="Actor"
          placeholder="Any actor"
          value={filters.actorId}
          onChange={(e) => setF('actorId', e.target.value)}
          options={(roster.data?.rows ?? []).map((r) => ({ value: r.id, label: r.name }))}
        />
        <span className="tiny muted">From</span>
        <Input
          type="date"
          aria-label="From date"
          value={filters.from}
          onChange={(e) => setF('from', e.target.value)}
        />
        <span className="tiny muted">To</span>
        <Input type="date" aria-label="To date" value={filters.to} onChange={(e) => setF('to', e.target.value)} />
        <Input
          placeholder="Search summaries…"
          aria-label="Search summaries"
          value={filters.q}
          onChange={(e) => setF('q', e.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFilters({ entityType: '', action: '', actorId: '', from: '', to: '', q: '' })}
        >
          Clear
        </Button>
      </div>

      <Card title="Audit trail" sub="Newest first.">
        {audit.error && audit.data ? <ErrorState error={audit.error} onRetry={audit.reload} /> : null}
        {table}
      </Card>

      {view ? <AuditDetailDialog row={view} onClose={() => setView(null)} /> : null}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="tiny muted strong">{label}</span>
      {value === null || value === undefined ? (
        <div className="tiny muted">null</div>
      ) : (
        <pre style={{ overflow: 'auto', maxHeight: 240, padding: 10, borderRadius: 8, fontSize: 12 }}>
          {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AuditDetailDialog({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  return (
    <Modal title="Audit entry" sub={`${row.action} · ${dateTime(row.at)}`} size="lg" onClose={onClose}>
      <div className="stack">
        <KeyValue
          items={[
            ['Action', row.action],
            ['Actor', row.actor_name || '—'],
            ['Entity', `${titleCase(row.entity_type)} · ${row.entity_id}`],
            ['Summary', row.summary || '—'],
            ['Time', dateTime(row.at)],
          ]}
        />
        <JsonBlock label="Before" value={row.before} />
        <JsonBlock label="After" value={row.after} />
        <JsonBlock label="Meta" value={row.meta} />
      </div>
    </Modal>
  );
}
