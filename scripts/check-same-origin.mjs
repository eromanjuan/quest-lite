/**
 * Same-origin smoke check — the counterpart to scripts/check-deploy.mjs.
 *
 * Used when the API also serves the built SPA (single host, or the Vite dev
 * proxy), where CORS is not involved and cookies are `SameSite=Lax`. This
 * matters because the session cookie's attributes are chosen per deployment:
 * `Lax` for same-origin and `None; Secure` for the split Firebase Hosting
 * deployment. Confirming the Lax path still works guards the local dev and
 * single-host setups against a change made for the split one.
 *
 * Usage: node scripts/check-same-origin.mjs [apiOrigin]
 */
const API = process.argv[2] ?? 'http://127.0.0.1:4066';

// Real credentials are required for the login checks — the seeded demo team no
// longer exists. Export CHECK_EMAIL / CHECK_PASSWORD before running.
const EMAIL = process.env.CHECK_EMAIL;
const PASSWORD = process.env.CHECK_PASSWORD;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const skip = (name, detail) => {
  results.push({ name, pass: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`);
};

const rawHeaders = (res) => {
  const out = {};
  for (const [k, v] of res.headers.entries()) out[k.toLowerCase()] = v;
  return out;
};

try {
  const res = await fetch(`${API}/api/health`);
  const body = await res.json();
  check('health responds', res.ok && body.ok === true, `db=${body.db} users=${body.users}`);
  check(
    'no CORS allow-list configured',
    Array.isArray(body.corsOrigins) && body.corsOrigins.length === 0,
    `corsOrigins=${JSON.stringify(body.corsOrigins)}`,
  );
} catch (err) {
  console.error(`API not reachable at ${API}: ${err.message}`);
  process.exit(1);
}

// Same-origin means no CORS headers are emitted at all — the browser does not
// need them and emitting them would invite a misconfiguration.
try {
  const res = await fetch(`${API}/api/health`, { headers: { Origin: 'https://some.other.site' } });
  const h = rawHeaders(res);
  check(
    'no CORS headers emitted',
    h['access-control-allow-origin'] === undefined,
    `got ${h['access-control-allow-origin'] ?? '(absent)'}`,
  );
} catch (err) {
  check('no CORS headers emitted', false, err.message);
}

// Login must set Lax here. `Secure` is tied to NODE_ENV=production, so over
// plain http:// on localhost the cookie is deliberately NOT Secure — a Secure
// cookie is never stored by the browser on an insecure origin, which would make
// local sign-in appear to succeed and then fail on the next request.
if (!EMAIL || !PASSWORD) {
  skip('login cookie checks', 'set CHECK_EMAIL and CHECK_PASSWORD to an existing account');
} else {
  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('ql_session=')) ?? '';
    const attrs = new Set(
      session
        .split(';')
        .slice(1)
        .map((p) => p.trim().split('=')[0].toLowerCase()),
    );
    check('login succeeds', res.ok, `status=${res.status}`);
    check('session cookie is set', session !== '', session || '(no ql_session cookie)');
    check(
      'session cookie is SameSite=Lax',
      /samesite=lax/i.test(session),
      session.split(';').slice(1).join(';').trim(),
    );
    check(
      'session cookie is not SameSite=None',
      !/samesite=none/i.test(session),
      'None would be dropped on a non-secure origin',
    );
    check('session cookie is HttpOnly', attrs.has('httponly'), session);
  } catch (err) {
    check('login', false, err.message);
  }
} 

// Round-trip: the cookie sign-in just issued must authenticate the next call.
if (!EMAIL || !PASSWORD) {
  skip('authenticated round-trip', 'set CHECK_EMAIL and CHECK_PASSWORD to an existing account');
} else {
  try {
    const login = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('ql_session='));
    const token = cookie?.split(';')[0];
    if (!token) {
      check('authenticated request with cookie', false, 'no session cookie to replay');
    } else {
      const res = await fetch(`${API}/api/auth/me`, { headers: { Cookie: token } });
      const body = await res.json().catch(() => ({}));
      check(
        'authenticated request with cookie',
        res.ok && !!body.user,
        `status=${res.status} user=${body.user?.email ?? '(none)'}`,
      );
    }
  } catch (err) {
    check('authenticated request with cookie', false, err.message);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Same-origin deployment is misconfigured. Fix the failures above.');
  process.exit(1);
}
console.log('Same-origin deployment is correctly configured.');
