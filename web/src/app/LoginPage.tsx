import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Input } from '../ui';
import { GoogleSignInSection } from './GoogleSignIn';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [blockers, setBlockers] = useState<Array<{ label: string; detail?: string }>>([]);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBlockers([]);
    setPending(true);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
        setBlockers(err.blockers.map((b) => ({ label: b.label, detail: b.detail })));
      } else {
        setError('Could not sign you in. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        placeItems: 'center',
        padding: 20,
        background:
          'radial-gradient(1100px 500px at 15% -10%, var(--accent-soft), transparent 60%), var(--bg)',
      }}
    >
      <div style={{ width: 'min(420px, 100%)' }}>
        <div className="row" style={{ gap: 10, marginBottom: 18, justifyContent: 'center' }}>
          <div
            className="rail-mark"
            style={{ width: 34, height: 34, fontSize: 16, borderRadius: 8 }}
            aria-hidden="true"
          >
            Q
          </div>
          <div>
            <div style={{ fontWeight: 700, letterSpacing: '0.02em' }}>QUEST LITE</div>
            <div className="tiny muted" style={{ letterSpacing: '0.11em', textTransform: 'uppercase' }}>
              Construction Operations
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-body" style={{ padding: 22 }}>
            <h1 style={{ fontSize: 17, marginBottom: 4 }}>Sign in</h1>
            <p className="muted small" style={{ marginBottom: 16 }}>
              One record, four workspaces. Your permissions decide what you see and what you can do.
            </p>

            <GoogleSignInSection onError={setError} />

            <form onSubmit={submit} className="stack" noValidate>
              {error ? (
                <div className="error-state" role="alert">
                  <b style={{ display: 'block', marginBottom: blockers.length ? 6 : 0 }}>{error}</b>
                  {blockers.length ? (
                    <ul className="blockers" style={{ marginTop: 4 }}>
                      {blockers.map((b, i) => (
                        <li key={i}>
                          <span className="lbl">
                            {b.label}
                            {b.detail ? <span className="det"> — {b.detail}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <Input
                label="Email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={fieldErrors.email}
                placeholder="you@company.com"
              />
              <Input
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                placeholder="Your password"
              />

              <Button type="submit" variant="primary" size="lg" block loading={pending}>
                Sign in
              </Button>
            </form>
          </div>

          <footer className="card-foot">
            <span className="small muted">
              No account yet?{' '}
              <Link to="/signup" className="btn btn-ghost btn-sm">
                Create one
              </Link>
            </span>
          </footer>
        </div>

        <p className="tiny muted" style={{ textAlign: 'center', marginTop: 14 }}>
          Server-side authorization is enforced on every route — hiding a control in this UI is
          never the security boundary.
        </p>
      </div>
    </div>
  );
}
