// node backup-db.ts <database> <copy>: a consistent copy of a live SQLite database (backup.sh).
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const [source, dest] = process.argv.slice(2);
if (!source || !dest) throw new Error('Usage: node backup-db.ts <database> <copy>');
if (!existsSync(source)) throw new Error(`There is no database at ${source}.`);

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}
