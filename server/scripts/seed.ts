import { seedConfiguration, purgeDemoAccounts } from '../db/seed.js';
import { logFirebaseStatus } from '../db/firebase.js';
import { firestoreReady, flush } from '../db/firestore-sync.js';

/**
 * Re-applies configuration seed data and scrubs any leftover demo accounts.
 * Safe to run repeatedly — every insert is idempotent.
 *
 * Accounts are no longer seeded: people sign up in the app, and the first
 * sign-up becomes the workspace Owner.
 */
logFirebaseStatus();
await firestoreReady();
await seedConfiguration();
const purged = purgeDemoAccounts();
await flush();

console.log('Configuration seeded.');
if (purged) console.log(`Retired ${purged} legacy demo account(s).`);
console.log('Accounts are created by signing up in the app — the first sign-up becomes the Owner.');
