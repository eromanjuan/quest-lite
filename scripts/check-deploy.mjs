/**
 * Split-deployment smoke check.
 *
 * The Firebase Hosting SPA calls the API cross-origin with credentials. Three
 * browser rules make that fragile, so each is verified directly rather than
 * assumed: an exact (non-wildcard) Access-Control-Allow-Origin, credentialed
 * preflight, and a SameSite=None; Secure session cookie on login. A failure in
 * any one of them looks identical from the UI — a signed-out screen — so this
 * script reports which layer broke.
 *
 * Usage: node scripts/check-deploy.mjs [apiOrigin]
 */
const API = process.argv[2] ?? 'http://127.0.0.1:4055';
const SITE = 'https://quest-lite.web.app';
const OTHER = 'https://evil.example.com';

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

// 1. Health, and that the allow-list is actually loaded from the environment.
try {
  const res = await fetch(`${API}/api/health`);
  const body = await res.json();
  check('health responds', res.ok && body.ok === true, `db=${body.db} users=${body.users}`);
  check(
    'CORS_ORIGINS loaded',
    Array.isArray(body.corsOrigins) && body.corsOrigins.includes(SITE),
    `corsOrigins=${JSON.stringify(body.corsOrigins)}`,
  );
} catch (err) {
  console.error(`API not reachable at ${API}: ${err.message}`);
  process.exit(1);
}

// 2. Preflight from the real site origin — must echo the exact origin, never *.
try {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: SITE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  const h = rawHeaders(res);
  check('preflight allowed (204)', res.status === 204, `status=${res.status}`);
  check(
    'preflight echoes exact origin',
    h['access-control-allow-origin'] === SITE,
    `got ${h['access-control-allow-origin']}`,
  );
  check(
    'preflight allows credentials',
    h['access-control-allow-credentials'] === 'true',
    `got ${h['access-control-allow-credentials']}`,
  );
} catch (err) {
  check('preflight', false, err.message);
}

// 3. A hostile origin must NOT be echoed back. A wildcard here would silently
//    defeat the allow-list and let any site call the API with user cookies.
try {
  const res = await fetch(`${API}/api/health`, { headers: { Origin: OTHER } });
  const h = rawHeaders(res);
  check(
    'unlisted origin not allowed',
    h['access-control-allow-origin'] !== OTHER,
    `got ${h['access-control-allow-origin'] ?? '(absent)'}`,
  );
} catch (err) {
  check('unlisted origin rejection', false, err.message);
}

// 4+5. Login must set SameSite=None; Secure, and the cookie must then replay.
//      Anything else is dropped by the browser in a cross-site context and
//      every request looks signed out.
if (!EMAIL || !PASSWORD) {
  skip('login cookie checks', 'set CHECK_EMAIL and CHECK_PASSWORD to an existing account');
} else {
  try {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const h = rawHeaders(res);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('ql_session=')) ?? '';
    // Parse the attribute list rather than matching across it — the string is a
    // sequence of ';'-separated pairs, so a regex over the raw text is brittle.
    const attrs = new Set(
      session
        .split(';')
        .slice(1)
        .map((p) => p.trim().split('=')[0].toLowerCase()),
    );
    check('login succeeds', res.ok, `status=${res.status}`);
    check('session cookie is set', session !== '', session || '(no ql_session cookie)');
    check('session cookie is SameSite=None', attrs.has('samesite') && /samesite=none/i.test(session), session);
    check('session cookie is Secure', attrs.has('secure'), session);
    check('session cookie is HttpOnly', attrs.has('httponly'), session);
    check('login is CORS-visible', h['access-control-allow-origin'] === SITE, `got ${h['access-control-allow-origin']}`);
  } catch (err) {
    check('login', false, err.message);
  }

  // 5. The real test: replay the cookie on an authenticated call. A deployment
  //    that sets a correct-looking cookie but fails here is still broken — this
  //    is what the browser does on every request after sign-in.
  try {
    const login = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('ql_session='));
    const token = cookie?.split(';')[0];
    if (!token) {
      check('authenticated request with cookie', false, 'no session cookie to replay');
    } else {
      const res = await fetch(`${API}/api/auth/me`, {
        headers: { Origin: SITE, Cookie: token },
      });
      const body = await res.json().catch(() => ({}));
      check(
        'authenticated request with cookie',
        res.ok && !!body.user,
        `status=${res.status} user=${body.user?.email ?? '(none)'} — an unauthenticated reply here means the cookie is being dropped`,
      );
    }
  } catch (err) {
    check('authenticated request with cookie', false, err.message);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('Split deployment will NOT authenticate from Firebase Hosting. Fix the failures above.');
  process.exit(1);
}
console.log('Split deployment is correctly configured for cross-origin cookies.');
