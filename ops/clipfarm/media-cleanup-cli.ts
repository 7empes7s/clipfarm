// node media-cleanup-cli.ts [--dry-run]: run by clipfarm-media-cleanup.timer (RUNBOOK.md, "Disk").
// Reads DATA_DIR, MEDIA_DIR and MEDIA_KEEP_REJECTED_DAYS from the environment, like the server.
import { join, resolve } from 'node:path';
import { cleanupMedia } from './media-cleanup.ts';

const dryRun = process.argv.includes('--dry-run');
const result = cleanupMedia({
  dbFile: join(resolve(process.env.DATA_DIR ?? 'data'), 'clipfarm.db'),
  mediaDir: resolve(process.env.MEDIA_DIR ?? 'media'),
  keepDays: Number(process.env.MEDIA_KEEP_REJECTED_DAYS) || 14,
  dryRun,
});
for (const path of result.removed) console.log(`${dryRun ? 'would remove' : 'removed'} ${path}`);
console.log(
  `clipfarm media cleanup: ${dryRun ? 'would free' : 'freed'} ${(result.bytes / 1e6).toFixed(1)} MB (${result.removed.length} files of long-rejected clips).`,
);
