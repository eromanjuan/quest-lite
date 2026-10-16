/**
 * Firebase Admin bootstrap.
 *
 * One module owns how this server reaches the `quest-lite` Firebase project so
 * credentials are resolved in exactly one place. Two services are used:
 * Firestore (the database of record — see firestore-sync.ts) and Auth (only
 * inspected by maintenance scripts).
 *
 * Credential resolution order:
 *   1. FIREBASE_SERVICE_ACCOUNT  — a JSON key file path, or the JSON itself
 *   2. ./firebase-service-account.json at the repository root
 *   3. Application default credentials (GOOGLE_APPLICATION_CREDENTIALS, or the
 *      attached service account when running on Google Cloud)
 *
 * Set FIRESTORE_SYNC=0 to run without any Firebase dependency (used by the
 * test suite); the app then behaves exactly like a plain SQLite deployment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

let app: App | null = null;
let initError: string | null = null;
let initialised = false;
let warned = false;

/** FIRESTORE_SYNC=0/false/off disables every Firebase interaction. */
export function firestoreSyncRequested(): boolean {
  const v = (process.env.FIRESTORE_SYNC ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(v);
}

function readServiceAccount(): { json: Record<string, unknown>; source: string } | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    if (raw.startsWith('{')) {
      try {
        return { json: JSON.parse(raw), source: 'FIREBASE_SERVICE_ACCOUNT (inline JSON)' };
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT looks like JSON but could not be parsed.');
      }
    }
    if (fs.existsSync(raw)) {
      return { json: JSON.parse(fs.readFileSync(raw, 'utf8')), source: raw };
    }
    console.warn(`[firebase] FIREBASE_SERVICE_ACCOUNT points at ${raw}, which does not exist.`);
  }
  const bundled = path.join(ROOT, 'firebase-service-account.json');
  if (fs.existsSync(bundled)) {
    return { json: JSON.parse(fs.readFileSync(bundled, 'utf8')), source: 'firebase-service-account.json' };
  }
  return null;
}

export function firebaseAdminApp(): App | null {
  if (initialised) return app;
  initialised = true;

  if (!firestoreSyncRequested()) return null;

  try {
    const existing = getApps()[0];
    if (existing) {
      app = existing;
      return app;
    }
    const sa = readServiceAccount();
    if (sa) {
      app = initializeApp({
        // The Admin SDK wants the camelCase form of the service-account JSON.
        credential: cert({
          projectId: String(sa.json.project_id ?? ''),
          clientEmail: String(sa.json.client_email ?? ''),
          // Windows checkouts commonly turn \n into \r\n inside the JSON.
          privateKey: String(sa.json.private_key ?? '').replace(/\r\n/g, '\n'),
        }),
        projectId: String(sa.json.project_id ?? ''),
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_USE_DEFAULT_CREDENTIALS === '1') {
      app = initializeApp({ credential: applicationDefault() });
    } else {
      initError =
        'no Firebase credentials found (set FIREBASE_SERVICE_ACCOUNT or add firebase-service-account.json)';
    }
  } catch (err) {
    app = null;
    initError = err instanceof Error ? err.message : String(err);
  }
  return app;
}

export function firestoreOrNull(): Firestore | null {
  const a = firebaseAdminApp();
  if (!a) return null;
  try {
    return getFirestore(a);
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export interface FirebaseStatus {
  enabled: boolean;
  requested: boolean;
  projectId: string | null;
  error: string | null;
}

export function firebaseStatus(): FirebaseStatus {
  const a = firebaseAdminApp();
  return {
    enabled: !!a,
    requested: firestoreSyncRequested(),
    projectId: (a?.options?.projectId as string | undefined) ?? null,
    error: initError,
  };
}

/** One boot-time line so the console states plainly where data is going. */
export function logFirebaseStatus(): void {
  if (warned) return;
  warned = true;
  const s = firebaseStatus();
  if (!s.requested) {
    console.log('[firebase] Firestore sync disabled (FIRESTORE_SYNC=0).');
  } else if (!s.enabled) {
    console.warn(`[firebase] Running on local SQLite only — ${initError}`);
  } else {
    console.log(`[firebase] Firestore connected → project ${s.projectId}`);
  }
}
