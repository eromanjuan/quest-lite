import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Input, Callout } from '../ui';
import { GoogleSignInSection } from './GoogleSignIn';

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    // Mirror the server's rules so a mistake is caught before the round trip.
    const local: Record<string, string> = {};
    if (name.trim().length < 2) local.name = 'Enter your full name.';
    if (!email.trim()) local.email = 'Enter your email address.';
    if (password.length < 8) local.password = 'Use at least 8 characters.';
    if (confirm !== password) local.confirm = 'Passwords do not match.';
    if (Object.keys(local).length) {
      setFieldErrors(local);
      return;
    }

    setPending(true);
    try {
      await signup({ email, name, password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not create your account. Please try again.');
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
            <h1 style={{ fontSize: 17, marginBottom: 4 }}>Create your account</h1>
            <p className="muted small" style={{ marginBottom: 16 }}>
              Join your team's workspace. Your role decides what you see and what you can do.
            </p>

            <GoogleSignInSection onError={setError} />

            <form onSubmit={submit} className="stack" noValidate>
              {error ? (
                <div className="error-state" role="alert">
                  <b>{error}</b>
                </div>
              ) : null}

              <Input
                label="Full name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={fieldErrors.name}
                placeholder="Jane Delgado"
              />
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
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                placeholder="At least 8 characters"
                hint="At least 8 characters."
              />
              <Input
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                error={fieldErrors.confirm}
                placeholder="Type it again"
              />

              <Button type="submit" variant="primary" size="lg" block loading={pending}>
                Create account
              </Button>
            </form>

            <Callout tone="grey">
              The first account created becomes the workspace <strong>Owner</strong>. Everyone after
              joins as a <strong>Prospecting Rep</strong>, and an Owner can change roles any time
              under Administration.
            </Callout>
          </div>

          <footer className="card-foot">
            <span className="small muted">
              Already have an account?{' '}
              <Link to="/login" className="btn btn-ghost btn-sm">
                Sign in
              </Link>
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
