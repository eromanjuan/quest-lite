import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable-ish, collision-resistant id: <prefix>_<time36><random>. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(10);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}

/** Human-facing sequential document number, e.g. BID-0007. */
export function formatNo(prefix: string, n: number, width = 4): string {
  return `${prefix}-${String(n).padStart(width, '0')}`;
}
