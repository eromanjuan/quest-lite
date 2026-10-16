import { useEffect, useState, type FormEvent } from 'react';
import { post, qs, ApiError } from '../../lib/api';
import { useDebounced, useFetch } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { useAuth } from '../../lib/auth';
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  PageHead,
  Select,
  TextArea,
} from '../../ui';
import { Icon } from '../../ui/icons';
import { initials } from '../../lib/format';
import { ContactCard } from './ContactCard';

interface ContactRow {
  id: string;
  first_name: string;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  is_decision_maker?: number | null;
  company_id?: string | null;
  company_name?: string | null;
  prospect_count?: number | null;
  project_count?: number | null;
  [key: string]: any;
}

interface CompanyRow {
  id: string;
  name: string;
  [key: string]: any;
}

interface Envelope<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const PAGE_SIZE = 25;
const CONTACT_FORM_ID = 'contacts-new-form';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
const fullName = (r: { first_name?: string | null; last_name?: string | null }) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '—';

export default function ContactsPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [companyId, setCompanyId] = useState('');
  const [offset, setOffset] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [cardId, setCardId] = useState<string | null>(null);

  const canWrite = can('crm.write');

  // Any filter change starts the result set over from the first page.
  useEffect(() => {
    setOffset(0);
  }, [dq, companyId]);

  const companies = useFetch<Envelope<CompanyRow>>('/companies?limit=100');
  const path = `/contacts${qs({ q: dq, companyId, limit: PAGE_SIZE, offset })}`;
  const list = useFetch<Envelope<ContactRow>>(path, [path]);

  const rows = list.data?.rows ?? [];
  const limit = list.data?.limit ?? PAGE_SIZE;
  const total = list.data?.total ?? 0;
  const hasMore = list.data?.hasMore ?? offset + rows.length < total;
  const active = !!(dq || companyId);
  const cardRow = cardId ? rows.find((r) => r.id === cardId) : undefined;

  let body;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={list.reload} />;
  } else if (list.loading && !list.data) {
    body = <Loading label="Loading contacts…" />;
  } else if (rows.length === 0) {
    body = active ? (
      <EmptyState title="No contacts match these filters" icon={<Icon name="filter" size={22} />}>
        Loosen or clear the filters to see the full list.
      </EmptyState>
    ) : (
      <EmptyState title="No contacts yet" icon={<Icon name="contacts" size={22} />}>
        Add the first contact to give every prospect, bid, deal and project a person to hang on.
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
                <th>Company</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Decision-maker</th>
                <th className="num">Prospects</th>
                <th className="num">Projects</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const name = fullName(r);
                return (
                  <tr key={r.id} className="clickable" onClick={() => setCardId(r.id)}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="avatar" aria-hidden="true">
                          {initials(name)}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="strong truncate" style={{ display: 'block' }} title={name}>
                            {name}
                          </span>
                          <span className="small muted truncate" style={{ display: 'block' }}>
                            {r.title || '—'}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="nowrap">{r.company_name ?? '—'}</td>
                    <td className="mono nowrap">{r.phone || r.mobile || '—'}</td>
                    <td className="nowrap">{r.email ?? '—'}</td>
                    <td>
                      {r.is_decision_maker ? (
                        <Badge tone="accent">Yes</Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">{r.prospect_count ?? '—'}</td>
                    <td className="num">{r.project_count ?? '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" onClick={() => setCardId(r.id)}>
                        Open card
                      </Button>
                    </td>
                  </tr>
                );
              })}
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
        title="Contacts"
        sub="One contact card aggregates every workspace record — nothing is duplicated."
      />

      <div className="filters">
        <Input
          type="search"
          aria-label="Search contacts"
          placeholder="Search name, email, phone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 210 }}
        />
        <Select
          aria-label="Company"
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          disabled={companies.loading && !companies.data}
          options={[
            { value: '', label: 'Any company' },
            ...(companies.data?.rows ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <span className="spacer" />
        <Button
          variant="primary"
          size="sm"
          disabled={!canWrite}
          title={canWrite ? undefined : 'You do not have permission to create contacts.'}
          icon={<Icon name="plus" size={14} />}
          onClick={() => setShowNew(true)}
        >
          New contact
        </Button>
      </div>

      {companies.error ? (
        <ErrorState error={companies.error} onRetry={companies.reload} />
      ) : null}

      {/* A failed refresh keeps the previous rows on screen — never hide the failure. */}
      {list.error && list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : null}

      {body}

      {showNew ? (
        <NewContactModal
          companies={companies.data?.rows ?? []}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            list.reload();
          }}
          onOpenExisting={(id) => {
            // Duplicate: close the form and show the record that already exists.
            setShowNew(false);
            setCardId(id);
          }}
        />
      ) : null}

      {cardId ? (
        <Drawer
          title={cardRow ? fullName(cardRow) : 'Contact card'}
          sub={cardRow?.company_name ?? undefined}
          onClose={() => setCardId(null)}
        >
          <ContactCard
            contactId={cardId}
            onClosed={() => setCardId(null)}
            onChanged={list.reload}
          />
        </Drawer>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* New contact                                                         */
/* ------------------------------------------------------------------ */

function NewContactModal({
  companies,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  companies: CompanyRow[];
  onClose: () => void;
  onCreated: () => void;
  onOpenExisting: (contactId: string) => void;
}) {
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [cid, setCid] = useState('');
  const [title, setTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [pref, setPref] = useState('phone');
  const [isDecisionMaker, setIsDecisionMaker] = useState(false);
  const [consentSms, setConsentSms] = useState(false);
  const [consentEmail, setConsentEmail] = useState(true);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);

  // The server names the existing contact, so the whole message is the headline.
  const [dupe, setDupe] = useState<{ message: string; existingId?: string } | null>(null);
  const [error, setError] = useState<{ message: string; fieldErrors: Record<string, string> } | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const form = document.getElementById(CONTACT_FORM_ID);
    if (form instanceof HTMLFormElement && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setPending(true);
    setError(null);
    setDupe(null);
    try {
      await post('/contacts', {
        companyId: cid || undefined,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        title: title.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        mobile: mobile.trim() || undefined,
        contactPref: pref,
        isDecisionMaker,
        consentSms,
        consentEmail,
        notes: notes.trim(),
      });
      toast.success('Contact created', `${firstName.trim()} ${lastName.trim()}`.trim());
      onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        // Duplicate prevention is the only 400/409 this endpoint can return;
        // everything else (422) is field validation.
        if (err.status === 409 || err.status === 400) {
          setDupe({ message: err.message, existingId: (err.details as any)?.existingId });
        } else {
          setError({ message: err.message, fieldErrors: err.fieldErrors });
        }
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
      title="New contact"
      sub="Contacts are deduplicated on name + phone or email."
      onClose={onClose}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={pending} onClick={() => void submit()}>
            Create contact
          </Button>
        </>
      }
    >
      <form id={CONTACT_FORM_ID} className="stack" onSubmit={submit}>
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
          Create contact
        </button>

        {dupe ? (
          <div className="warn-state" role="alert">
            <b>Contact already on file</b>
            <div style={{ margin: '4px 0 8px' }}>{dupe.message}</div>
            {dupe.existingId ? (
              <Button
                size="sm"
                onClick={() => onOpenExisting(dupe.existingId as string)}
              >
                Open the existing contact
              </Button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="error-state" role="alert">
            {error.message}
          </div>
        ) : null}

        <div className="form-grid">
          <Input
            label="First name"
            required
            value={firstName}
            error={fe.firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
          />
          <Input
            label="Last name"
            value={lastName}
            error={fe.lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
          />
          <Select
            label="Company"
            value={cid}
            onChange={(e) => setCid(e.target.value)}
            placeholder="No company"
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Input
            label="Title"
            value={title}
            error={fe.title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Owner, Estimator…"
          />
          <Input
            label="Phone"
            value={phone}
            error={fe.phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
          <Input
            label="Mobile"
            value={mobile}
            error={fe.mobile}
            onChange={(e) => setMobile(e.target.value)}
            autoComplete="tel"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            error={fe.email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <Select
            label="Preferred contact"
            value={pref}
            onChange={(e) => setPref(e.target.value)}
            options={[
              { value: 'phone', label: 'Phone' },
              { value: 'text', label: 'Text' },
              { value: 'email', label: 'Email' },
            ]}
          />
        </div>

        <Checkbox
          label="Decision-maker"
          checked={isDecisionMaker}
          onChange={(e) => setIsDecisionMaker(e.target.checked)}
        />
        <Checkbox
          label="SMS consent"
          hint="Required before text automation will run"
          checked={consentSms}
          onChange={(e) => setConsentSms(e.target.checked)}
        />
        <Checkbox
          label="Email consent"
          checked={consentEmail}
          onChange={(e) => setConsentEmail(e.target.checked)}
        />
        <TextArea
          label="Notes"
          value={notes}
          error={fe.notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything the whole workspace should know about this person."
        />
      </form>
    </Modal>
  );
}
