import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { patch, post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  KeyValue,
  Loading,
  Modal,
  PageHead,
  Select,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { dateShort, titleCase } from '../../lib/format';
import { ContactCard } from './ContactCard';

interface CompanyRow {
  id: string;
  name: string;
  kind?: string | null;
  territory_name?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  notes?: string | null;
  territory_id?: string | null;
  created_at?: number | null;
  contact_count?: number | null;
  archived_at?: number | null;
  [key: string]: any;
}

interface ContactRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  [key: string]: any;
}

interface Envelope<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

interface Territory {
  id: string;
  name: string;
  [key: string]: any;
}

const PAGE_SIZE = 25;
const COMPANY_FORM_ID = 'companies-new-form';

const KINDS = ['customer', 'gc', 'vendor', 'subcontractor', 'other'];

const KIND_TONES: Record<string, 'green' | 'blue' | 'amber' | 'violet' | 'neutral'> = {
  customer: 'green',
  gc: 'blue',
  vendor: 'amber',
  subcontractor: 'violet',
  other: 'neutral',
};

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export default function CompaniesPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [kind, setKind] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);

  const canWrite = can('crm.write');

  // Any filter change starts the result set over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [dq, kind, showArchived]);

  const config = useFetch<{ territories?: Territory[] }>('/config');
  const territories = config.data?.territories ?? [];

  const path = `/companies${qs({
    q: dq,
    kind,
    archived: showArchived ? 1 : undefined,
    limit: PAGE_SIZE,
    offset,
  })}`;
  const list = useFetch<Envelope<CompanyRow>>(path, [path]);

  const rows = list.data?.rows ?? [];
  const limit = list.data?.limit ?? PAGE_SIZE;
  const total = list.data?.total ?? 0;
  const hasMore = list.data?.hasMore ?? offset + rows.length < total;
  const active = !!(dq || kind || showArchived);
  const openRow = companyId ? rows.find((r) => r.id === companyId) : undefined;

  let body;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading companies…" />;
  } else if (rows.length === 0) {
    body = active ? (
      <EmptyState title="No companies match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the filters to see the full list.
      </EmptyState>
    ) : (
      <EmptyState title="No companies yet" icon={<Icon name="companies" size={22} />}>
        Create a company to group contacts by customer, GC, vendor or subcontractor.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Territory</th>
                <th>Phone</th>
                <th>Email</th>
                <th className="num">Contacts</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setCompanyId(r.id)}>
                  <td>
                    <div className="strong truncate" style={{ maxWidth: 240 }} title={r.name}>
                      {r.name}
                    </div>
                    <div className="small muted truncate" style={{ maxWidth: 240 }}>
                      {r.address || r.website || '—'}
                    </div>
                  </td>
                  <td>
                    <Badge tone={KIND_TONES[r.kind ?? ''] ?? 'neutral'}>
                      {r.kind ? titleCase(r.kind) : '—'}
                    </Badge>
                  </td>
                  <td className="nowrap">{r.territory_name ?? '—'}</td>
                  <td className="mono nowrap">{r.phone || '—'}</td>
                  <td className="nowrap">{r.email ?? '—'}</td>
                  <td className="num">{r.contact_count ?? '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" onClick={() => setCompanyId(r.id)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">
            {total === 0 ? 'No rows' : `Showing ${offset + 1}–${offset + rows.length} of ${total}`}
          </span>
          <span className="spacer" />
          <Button
            size="sm"
            disabled={offset === 0 || list.loading}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            disabled={!hasMore || list.loading}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Companies"
        sub="Customers, GCs, vendors and subcontractors — each one owns the contacts filed under it."
        actions={
          <Button
            variant="primary"
            size="sm"
            disabled={!canWrite}
            title={canWrite ? undefined : 'You do not have permission to create companies.'}
            icon={<Icon name="plus" size={14} />}
            onClick={() => setShowNew(true)}
          >
            New company
          </Button>
        }
      />

      <div className="filters">
        <Input
          type="search"
          aria-label="Search companies"
          placeholder="Search name, phone, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 210 }}
        />
        <Select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          options={[
            { value: '', label: 'Any kind' },
            ...KINDS.map((k) => ({ value: k, label: titleCase(k) })),
          ]}
        />
        <Checkbox
          label="Show archived"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        <span className="spacer" />
      </div>

      {config.error ? <ErrorState error={config.error} onRetry={config.reload} /> : null}

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}

      {showNew ? (
        <NewCompanyModal
          territories={territories}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            list.reload();
          }}
        />
      ) : null}

      {companyId ? (
        <Drawer
          title={contactId ? 'Contact card' : openRow?.name ?? 'Company'}
          sub={contactId ? undefined : openRow?.kind ? titleCase(openRow.kind) : undefined}
          onClose={() => (contactId ? setContactId(null) : setCompanyId(null))}
        >
          {contactId ? (
            // "Open card" swaps the drawer body; closing the card returns to the company.
            <ContactCard
              contactId={contactId}
              onClosed={() => setContactId(null)}
              onChanged={list.reload}
            />
          ) : (
            <CompanyDrawer
              companyId={companyId}
              territories={territories}
              canWrite={canWrite}
              onChanged={list.reload}
              onOpenContact={setContactId}
            />
          )}
        </Drawer>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Company detail: read, edit, and the contacts filed under it         */
/* ------------------------------------------------------------------ */

function CompanyDrawer({
  companyId,
  territories,
  canWrite,
  onChanged,
  onOpenContact,
}: {
  companyId: string;
  territories: Territory[];
  canWrite: boolean;
  onChanged: () => void;
  onOpenContact: (contactId: string) => void;
}) {
  const toast = useToast();
  const detail = useFetch<{ company: CompanyRow; contacts: ContactRow[] }>(
    `/companies/${companyId}`,
    [companyId],
  );
  const company = detail.data?.company;

  const [form, setForm] = useState({
    name: '',
    kind: 'customer',
    territoryId: '',
    website: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the form from the server row (on first load and after every save).
  useEffect(() => {
    if (!company) return;
    setForm({
      name: company.name ?? '',
      kind: company.kind ?? 'customer',
      territoryId: company.territory_id ?? '',
      website: company.website ?? '',
      phone: company.phone ?? '',
      email: company.email ?? '',
      address: company.address ?? '',
      notes: company.notes ?? '',
    });
  }, [company]);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.name.trim()) {
      setSaveError('A company name is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await patch(`/companies/${companyId}`, {
        name: form.name.trim(),
        kind: form.kind,
        territoryId: form.territoryId || null,
        website: form.website.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        notes: form.notes.trim(),
      });
      toast.success('Company saved');
      detail.reload();
      onChanged();
    } catch (err) {
      setSaveError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  if (detail.error && !detail.data) {
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  if (detail.loading && !detail.data) {
    return <Loading label="Loading company…" />;
  }
  if (!company) return null;

  const contacts = detail.data?.contacts ?? [];

  const details: Array<[ReactNode, ReactNode]> = [
    ['Kind', <Badge tone={KIND_TONES[company.kind ?? ''] ?? 'neutral'}>{company.kind ? titleCase(company.kind) : '—'}</Badge>],
    ['Territory', company.territory_name ?? '—'],
    ['Website', company.website || '—'],
    ['Phone', <span className="mono">{company.phone || '—'}</span>],
    ['Email', company.email ?? '—'],
    ['Address', company.address || '—'],
    ['Created', company.created_at ? dateShort(company.created_at) : '—'],
    ['Archived', company.archived_at ? 'Yes' : 'No'],
  ];
  if (company.notes) details.push(['Notes', company.notes]);

  return (
    <div className="stack">
      <Card title="Details">
        <KeyValue items={details} />
      </Card>

      {canWrite ? (
        <Card title="Edit company" sub="Saved to the workspace the moment you press save.">
          <form className="stack" onSubmit={save}>
            <div className="form-grid">
              <Input
                label="Name"
                required
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
              />
              <Select
                label="Kind"
                value={form.kind}
                onChange={(e) => set('kind')(e.target.value)}
                options={KINDS.map((k) => ({ value: k, label: titleCase(k) }))}
              />
              <Select
                label="Territory"
                value={form.territoryId}
                onChange={(e) => set('territoryId')(e.target.value)}
                placeholder="No territory"
                options={territories.map((t) => ({ value: t.id, label: t.name }))}
              />
              <Input
                label="Website"
                value={form.website}
                onChange={(e) => set('website')(e.target.value)}
              />
              <Input
                label="Phone"
                value={form.phone}
                onChange={(e) => set('phone')(e.target.value)}
              />
              <Input
                label="Email"
                type="email"
                value={form.email}
                onChange={(e) => set('email')(e.target.value)}
              />
              <Input
                label="Address"
                className="span-2"
                value={form.address}
                onChange={(e) => set('address')(e.target.value)}
              />
            </div>
            <TextArea
              label="Notes"
              value={form.notes}
              onChange={(e) => set('notes')(e.target.value)}
            />
            {saveError ? (
              <div className="error-state" role="alert">
                {saveError}
              </div>
            ) : null}
            <div className="row wrap">
              <span className="spacer" />
              <Button type="submit" variant="primary" loading={saving}>
                Save changes
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="Contacts" sub={`${contacts.length} on file`} flush>
        {contacts.length === 0 ? (
          <EmptyState title="No contacts yet" icon={<Icon name="contacts" size={22} />}>
            Create a contact and attach it to this company from the Contacts page.
          </EmptyState>
        ) : (
          <div className="list">
            {contacts.map((c) => {
              const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '—';
              return (
                <div className="list-item" key={c.id}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong small truncate" title={name}>
                      {name}
                    </div>
                    <div className="tiny muted truncate">
                      {[c.title, c.phone || c.mobile, c.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => onOpenContact(c.id)}>
                    Open card
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New company                                                         */
/* ------------------------------------------------------------------ */

function NewCompanyModal({
  territories,
  onClose,
  onCreated,
}: {
  territories: Territory[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('customer');
  const [territoryId, setTerritoryId] = useState('');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; fieldErrors: Record<string, string> } | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const form = document.getElementById(COMPANY_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await post('/companies', {
        name: name.trim(),
        kind,
        territoryId: territoryId || undefined,
        website: website.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        notes: notes.trim(),
      });
      toast.success('Company created', name.trim());
      onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message, fieldErrors: err.fieldErrors });
      } else {
        setError({ message: errText(err), fieldErrors: {} });
      }
    } finally {
      setPending(false);
    }
  };

  const fe = error?.fieldErrors ?? {};

  return (
    <Modal
      title="New company"
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={pending} onClick={() => void submit()}>
            Create company
          </Button>
        </>
      }
    >
      <form id={COMPANY_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create company
        </button>
        {error ? (
          <div className="error-state" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="form-grid">
          <Input
            label="Name"
            required
            value={name}
            error={fe.name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Roofing LLC"
          />
          <Select
            label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={KINDS.map((k) => ({ value: k, label: titleCase(k) }))}
          />
          <Select
            label="Territory"
            value={territoryId}
            onChange={(e) => setTerritoryId(e.target.value)}
            placeholder="No territory"
            options={territories.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Input
            label="Website"
            value={website}
            error={fe.website}
            onChange={(e) => setWebsite(e.target.value)}
          />
          <Input
            label="Phone"
            value={phone}
            error={fe.phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label="Email"
            type="email"
            value={email}
            error={fe.email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Address"
            className="span-2"
            value={address}
            error={fe.address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <TextArea
          label="Notes"
          value={notes}
          error={fe.notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </form>
    </Modal>
  );
}
