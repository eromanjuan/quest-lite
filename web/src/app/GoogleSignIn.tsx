import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { get, ApiError } from '../lib/api';

/**
 * "Continue with Google" — the official Identity Services button, followed by
 * an "or with email" divider. The whole section renders only when the API
 * reports a configured GOOGLE_CLIENT_ID, so a deployment without Google
 * credentials simply shows the email/password form with no dead button, no
 * stray divider and no console noise. The button itself comes from Google's
 * script; the credential it produces is posted to /auth/google, which decides
 * whether this is a sign-in or a sign-up.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (options: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

let gsiPromise: Promise<boolean> | null = null;

/** Injects the Google script exactly once per page, even across remounts. */
function loadGoogleIdentityServices(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(true), { once: true });
        existing.addEventListener('error', () => resolve(false), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return gsiPromise;
}

export function GoogleSignInSection({ onError }: { onError: (message: string) => void }) {
  const { loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);

  // The API is the single source of truth for whether Google sign-in exists here.
  useEffect(() => {
    let cancelled = false;
    get<{ enabled: boolean; clientId: string | null }>('/auth/google/status')
      .then((s) => {
        if (!cancelled && s.enabled && s.clientId) setClientId(s.clientId);
      })
      .catch(() => undefined); // API unreachable → stay hidden, the form still works
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void loadGoogleIdentityServices().then((ok) => {
      if (cancelled) return;
      if (!ok) setScriptFailed(true);
      else setScriptReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !scriptReady || !hostRef.current) return;
    const google = window.google?.accounts?.id;
    if (!google) return;
    // Google's documented order: initialize() carries the credential callback,
    // then renderButton() paints the official button into our container.
    google.initialize({
      client_id: clientId,
      callback: async (response: { credential?: string }) => {
        if (!response.credential) {
          onError('Google did not return a sign-in credential. Please try again.');
          return;
        }
        try {
          await loginWithGoogle(response.credential);
          navigate('/', { replace: true });
        } catch (err) {
          onError(
            err instanceof ApiError
              ? err.message
              : 'Could not sign you in with Google. Please try again.',
          );
        }
      },
    });
    google.renderButton(hostRef.current, {
      theme: 'outline',
      size: 'large',
      shape: 'rectangular',
      text: 'continue_with',
      width: Math.max(260, Math.min(340, hostRef.current.clientWidth || 320)),
    });
  }, [clientId, scriptReady, loginWithGoogle, navigate, onError]);

  if (!clientId) return null;

  return (
    <div>
      <div className="stack" style={{ alignItems: 'stretch' }}>
        <div
          ref={hostRef}
          style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }}
          aria-label="Continue with Google"
        />
        {scriptFailed ? (
          <p className="tiny muted" style={{ textAlign: 'center' }}>
            Google sign-in could not load. Check your connection, or use your email and password
            below.
          </p>
        ) : null}
      </div>
      <div className="row" style={{ gap: 10, margin: '4px 0 14px' }} aria-hidden="true">
        <hr className="divider" style={{ flex: 1, margin: 0 }} />
        <span className="tiny muted">or with email</span>
        <hr className="divider" style={{ flex: 1, margin: 0 }} />
      </div>
    </div>
  );
}
