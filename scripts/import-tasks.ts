import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createDb, migrate } from '@tr/db';
import {
  adapterFor, assertWithinLimits, createBatch, stageRows, applyMapping,
  analyzeBatch, unmappedCategories, getStagedRows, getConflicts,
  confirmBatch, importBatch, rollbackBatch, listBatches, getBatch, getAudit,
  type ImportMapping, type ImportSourceType,
} from '@tr/importer';

const SOURCE_TYPES: ImportSourceType[] = ['csv', 'json', 'kanban'];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(): never {
  console.log(`
Import legacy tasks. Nothing is written without --confirm.

  pnpm import-tasks -- --file <path> --type <csv|json|kanban> [options]
  pnpm import-tasks -- --list
  pnpm import-tasks -- --batch <id>
  pnpm import-tasks -- --rollback <id> [--force]

Options
  --map <path>    JSON mapping file: { spaces, assignees, statuses, defaultSpace }
  --actor <id>    Slack user id recorded as the confirmer (required with --confirm)
  --confirm       actually write the tasks; without it you get a preview only
  --force         with --rollback, also delete tasks edited since import
  --limit <n>     with --list, how many batches to show (default 20)
`.trim());
  process.exit(1);
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const db = await createDb();
await migrate(db);

try {
  // ---------------------------------------------------------------- list
  if (has('list')) {
    const batches = await listBatches(db, Number(flag('limit') ?? 20));
    if (batches.length === 0) {
      console.log('No import batches yet.');
    } else {
      console.log(`${padRight('BATCH', 38)}${padRight('SOURCE', 10)}${padRight('STATE', 13)}ROWS  CREATED`);
      for (const b of batches) {
        console.log(
          padRight(b.id, 38) + padRight(b.source_type, 10) +
          padRight(b.state, 13) + padRight(String(b.row_count), 6) +
          new Date(b.created_at).toISOString().slice(0, 16).replace('T', ' ')
        );
      }
    }
    process.exit(0);
  }

  // --------------------------------------------------------------- batch
  const batchIdFlag = flag('batch');
  if (batchIdFlag) {
    const batch = await getBatch(db, batchIdFlag);
    if (!batch) {
      console.error(`No batch ${batchIdFlag}`);
      process.exit(1);
    }
    console.log(`batch    ${batch.id}`);
    console.log(`source   ${batch.source_type}  ${batch.filename ?? ''}`);
    console.log(`state    ${batch.state}`);
    console.log(`rows     ${batch.row_count}`);
    if (batch.confirmed_by) {
      console.log(`confirmed by ${batch.confirmed_by} at ${batch.confirmed_at?.toISOString()}`);
    }
    const audit = await getAudit(db, batch.id);
    if (audit.length > 0) {
      console.log('\naudit:');
      const counts = new Map<string, number>();
      for (const a of audit) counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
      for (const [action, n] of counts) console.log(`  ${padRight(action, 20)}${n}`);
    }
    process.exit(0);
  }

  // ------------------------------------------------------------ rollback
  const rollbackId = flag('rollback');
  if (rollbackId) {
    const result = await rollbackBatch(db, rollbackId, { force: has('force') });
    console.log(`rolled back ${result.deleted} task(s)`);
    if (result.refused > 0) {
      console.log(
        `refused ${result.refused} task(s) edited since import; ` +
        `re-run with --force to delete them anyway:`
      );
      for (const id of result.refusedTaskIds) console.log(`  ${id}`);
    }
    process.exit(0);
  }

  // -------------------------------------------------------------- import
  const file = flag('file');
  const type = flag('type') as ImportSourceType | undefined;
  if (!file || !type) usage();
  if (!SOURCE_TYPES.includes(type)) {
    console.error(`--type must be one of ${SOURCE_TYPES.join(', ')}`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    console.error(`Cannot read ${file}`);
    process.exit(1);
  }

  // Size, row count, and a content sniff, all before parsing.
  assertWithinLimits(raw, type);

  let mapping: ImportMapping = {};
  const mapPath = flag('map');
  if (mapPath) {
    mapping = JSON.parse(await readFile(mapPath, 'utf8')) as ImportMapping;
  }

  const rows = adapterFor(type)(raw);
  const batchId = await createBatch(db, {
    sourceType: type, filename: basename(file), createdBy: flag('actor') ?? null,
  });
  await stageRows(db, batchId, rows);
  await applyMapping(db, batchId, mapping);
  const counts = await analyzeBatch(db, batchId);

  console.log(`batch ${batchId}`);
  console.log(`parsed ${rows.length} row(s) from ${basename(file)}\n`);
  console.log(`  READY TO IMPORT   ${counts.READY}`);
  console.log(`  SKIP - DUPLICATE  ${counts.SKIP_DUPLICATE}`);
  console.log(`  NEEDS REVIEW      ${counts.NEEDS_REVIEW}`);
  console.log(`  INVALID           ${counts.INVALID}`);

  const unmapped = await unmappedCategories(db, batchId);
  if (unmapped.length > 0) {
    console.log(`\nunmapped source categories (add these to --map):`);
    for (const category of unmapped) console.log(`  ${category}`);
  }

  const conflicts = await getConflicts(db, batchId);
  if (conflicts.length > 0) {
    console.log(`\nrows needing attention:`);
    for (const row of conflicts) {
      console.log(`  [${row.verdict}] row ${row.row_number}: ${JSON.stringify(row.title)}`);
      console.log(`      ${row.reason ?? ''}`);
    }
  }

  const ready = await getStagedRows(db, batchId, 'READY');
  if (ready.length > 0) {
    console.log(`\nwould create ${ready.length} task(s):`);
    for (const row of ready.slice(0, 30)) {
      console.log(`  ${JSON.stringify(row.title)}`);
    }
    if (ready.length > 30) console.log(`  ... and ${ready.length - 30} more`);
  }

  if (!has('confirm')) {
    console.log(`\nNothing was written. Re-run with --confirm --actor <slack-user-id> to import.`);
    process.exit(0);
  }

  const actor = flag('actor');
  if (!actor) {
    console.error('\n--confirm requires --actor <slack-user-id>, recorded as the confirmer.');
    process.exit(1);
  }

  await confirmBatch(db, batchId, { id: actor });
  const report = await importBatch(db, batchId);

  console.log(`\nimported   ${report.imported}`);
  console.log(`skipped    ${report.skipped}`);
  console.log(`review     ${report.needsReview}`);
  console.log(`failed     ${report.failed}`);
  console.log(`\nbatch ${report.batchId} at ${report.importedAt}`);
  console.log(`roll back with: pnpm import-tasks -- --rollback ${report.batchId}`);
} finally {
  await db.close();
}
