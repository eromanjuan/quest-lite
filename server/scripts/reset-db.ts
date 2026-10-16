import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, resetDbHandle } from '../db/database.js';

/**
 * Deletes the local SQLite database so the next start rebuilds it from the
 * migrations and seeds. Refuses to run when DATABASE_PATH points outside the
 * project, so a stray env var cannot wipe an unrelated file.
 */
const target = path.resolve(DB_PATH);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

if (!target.startsWith(projectRoot)) {
  console.error(`Refusing to delete ${target}: it is outside the project (${projectRoot}).`);
  process.exit(1);
}

resetDbHandle();
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const file = target + suffix;
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`removed ${path.basename(file)}`);
  }
}
console.log('Database reset. It will be recreated from migrations on next start.');
