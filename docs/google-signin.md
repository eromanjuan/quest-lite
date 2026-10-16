# Google sign-in

"Continue with Google" on the sign-in and sign-up pages. Google only proves
that the person owns the email address — **accounts, roles and sessions are
still created by the Quest Lite API**, exactly like email/password sign-up:

| Situation | Result |
| --- | --- |
| Google email matches an existing account | Signs into that account (role unchanged) |
| First account ever | Created as **Owner** |
| Any later Google account | Created as a **Prospecting Rep** |
| Account deactivated by an admin | Rejected with a clear message |

Google-managed accounts have no app password (`password_hash` holds a
`google:<sub>` sentinel), so they can only sign in through Google until an
administrator sets a password under Administration → Users.

## One-time setup (Google Cloud console)

The button appears only when a client ID is configured — until then the pages
render email/password alone.

1. Open https://console.cloud.google.com/ and select the **quest-lite** project
   (the same one Firebase runs on).
2. **APIs & Services → OAuth consent screen**
   - User type: **External**, app name `Quest Lite`, your support email.
   - Scopes: leave the defaults (`email`, `profile`, `openid`).
   - While the app is in **Testing** mode, add every Gmail address that should
     be able to sign in under *Test users*. **Publish** the app to allow any
     Google account.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Type: **Web application**.
   - **Authorized JavaScript origins** (the button only works from these):
     ```
     http://127.0.0.1:5173
     http://localhost:5173
     https://quest-lite.web.app
     ```
     plus your production SPA origin if you use a custom domain. No redirect
     URI is needed for the button flow.
4. Copy the client ID (`…apps.googleusercontent.com`) into your environment:
   ```bash
   # .env (local)
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   ```
   On Render, add the same variable to the service. Comma-separate several
   client IDs if local and production use different ones.
5. Restart the API. `/api/health` is unaffected; `/api/auth/google/status`
   reports `{"enabled":true,"clientId":"…"}` and the SPA renders the button
   without a rebuild — it reads its configuration from the API.

## How it works

* `web/src/app/GoogleSignIn.tsx` loads Google's Identity Services script, asks
  the API whether sign-in is configured, renders the official button, and posts
  the resulting credential to `/api/auth/google`.
* `server/routes/auth.ts` verifies the token **server-side** with
  `google-auth-library` (audience must match `GOOGLE_CLIENT_ID`), requires a
  Google-verified email, then find-or-creates the local user and issues the
  usual session cookie. The token itself is never stored.
* A rejected token returns a deliberately generic error; details are only
  logged on the server.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No Google button at all | `GOOGLE_CLIENT_ID` not set on the API (check `/api/auth/google/status`) |
| Button present, nothing happens / console error about origin | That origin is not in the OAuth client's *Authorized JavaScript origins* |
| "Access blocked: app is in testing mode" | The Gmail address is not listed as a test user, or the consent screen was never published |
| "Verify the email address on your Google account" | The Google account itself has an unverified email |
