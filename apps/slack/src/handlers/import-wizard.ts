import type { Db } from '@tr/db';
import { listSpaces, type Space } from '@tr/task-core';
import {
  assertWithinLimits, adapterFor,
  createBatch, stageRows, getBatch, getStagedRows,
  applyMapping, unmappedCategories, analyzeBatch, verdictCounts,
  confirmBatch, importBatch, verifyBatch, abortBatch,
  ImportParseError, ImportLimitError, ImportStateError,
  MAX_FILE_BYTES,
  type ImportMapping, type ImportReport,
} from '@tr/importer';
import {
  importUploadView, importMappingView, importPreviewView,
  importWorkingView, importErrorView,
  parseUploadSubmission, parseMappingSubmission,
  NO_CATEGORY, type UploadMeta, type WizardMeta,
} from '@tr/slack-ui';
import { authorize } from '../auth.js';
import type { AppConfig } from '../config.js';

export {
  IMPORT_CALLBACK_IDS, IMPORT_BLOCKS, IMPORT_ACTIONS,
} from '@tr/slack-ui';

/**
 * The import wizard: a native Slack surface over `packages/importer`.
 *
 * It issues no task SQL and performs no mapping logic of its own. Every write
 * goes through the importer, which refuses to import a batch that is not
 * CONFIRMED -- so "explicit human confirmation before anything is written"
 * stays a property of the engine rather than a promise made by this file.
 *
 * ## Why each step acks before it works
 *
 * Slack drops a `view_submission` that is not acknowledged within 3 seconds.
 * Downloading a file and staging up to MAX_ROWS rows does not fit in that
 * budget. So every slow step returns two things: the payload to ack with
 * immediately, and a continuation to run afterwards which finishes the work
 * and calls `views.update`. Tests drive the continuation directly.
 */

export interface FetchedFile {
  name: string | null;
  /** From files.info when available, so an oversized file is refused early. */
  size: number | null;
  text: string;
}

export interface ImportDeps {
  db: Db;
  client: {
    views: {
      open: (args: Record<string, unknown>) => Promise<unknown>;
      update: (args: Record<string, unknown>) => Promise<unknown>;
    };
    chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> };
  };
  config: AppConfig;
  /**
   * Injected rather than built here: reading an uploaded file needs the bot
   * token and the network, and no unit test should need either.
   */
  fetchFile: (fileId: string) => Promise<FetchedFile>;
}

/** What the caller passes to `ack()`, plus the work to do after acking. */
export interface SubmitResult {
  ack: Record<string, unknown> | undefined;
  after?: () => Promise<void>;
}

export type CommandOutcome = 'opened' | 'unauthorized';

/** `/import` opens the upload view. Nothing is written. */
export async function handleImportCommand(
  deps: ImportDeps, body: Record<string, any>
): Promise<{ outcome: CommandOutcome }> {
  // A slash-command payload is flat (`team_id`, `user_id`); `authorize` reads
  // the nested shape that interaction payloads use, so it is adapted here the
  // same way /task does.
  const auth = authorize(
    { team: { id: body.team_id }, user: { id: body.user_id } } as never, deps.config
  );
  if (!auth.ok) return { outcome: 'unauthorized' };

  const meta: UploadMeta = { channelId: body.channel_id ?? '' };
  await deps.client.views.open({
    trigger_id: body.trigger_id,
    view: importUploadView(meta),
  });
  return { outcome: 'opened' };
}

/**
 * Step 1 to 3: read the file, stage it, resolve what the mapping already
 * covers, then either ask about the leftovers or go straight to the preview.
 *
 * A batch row is created only after the bytes have been validated, so a
 * rejected file leaves no batch behind to abort.
 */
export function handleUploadSubmit(
  deps: ImportDeps, body: Record<string, any>
): SubmitResult {
  const parsed = parseUploadSubmission(body?.view ?? {});
  if (parsed.error) {
    return {
      ack: {
        response_action: 'errors',
        errors: { [parsed.error.blockId]: parsed.error.message },
      },
    };
  }

  const viewId: string = body?.view?.id ?? '';
  const actorId: string | null = body?.user?.id ?? null;
  const meta = parsed.meta;

  return {
    ack: {
      response_action: 'update',
      view: importWorkingView(meta, 'Reading the file. Nothing is written yet.'),
    },
    after: async () => {
      try {
        const file = await deps.fetchFile(parsed.fileIds[0]!);

        // Refuse on the metadata size before parsing, so a 100 MB upload --
        // which Slack permits and we do not -- is rejected without being
        // pushed through the adapter.
        if (file.size !== null && file.size > MAX_FILE_BYTES) {
          throw new ImportLimitError(
            `File is ${mib(file.size)} MiB; the limit is ${mib(MAX_FILE_BYTES)} MiB.`
          );
        }

        const sourceType = parsed.sourceType;
        // This one call enforces the size cap, the row cap, and that the
        // declared source type agrees with the actual bytes. That rule lives
        // in the importer, not here -- duplicating it in this handler is how
        // the two copies drift.
        assertWithinLimits(file.text, sourceType);

        const rows = adapterFor(sourceType)(file.text);
        if (rows.length === 0) {
          throw new ImportParseError('The file parsed cleanly but contained no rows.');
        }

        const batchId = await createBatch(deps.db, {
          sourceType, filename: file.name, createdBy: actorId,
        });
        await stageRows(deps.db, batchId, rows);

        // Resolve with an empty mapping first: whatever already matches a
        // Space by name, slug or alias needs no question asked.
        await applyMapping(deps.db, batchId, {}, { timeZone: deps.config.timeZone });
        const unmapped = await unmappedCategories(deps.db, batchId);

        const wizardMeta: WizardMeta = { batchId, channelId: meta.channelId };

        if (unmapped.length > 0) {
          const spaces = await listSpaces(deps.db);
          await deps.client.views.update({
            view_id: viewId,
            view: importMappingView(wizardMeta, unmapped, spaces as Space[]),
          });
          return;
        }

        await showPreview(deps, viewId, wizardMeta, file.name);
      } catch (error) {
        await deps.client.views.update({
          view_id: viewId,
          view: importErrorView(meta, explain(error)),
        });
      }
    },
  };
}

/** Step 3 to 5: apply the answers, analyze, show the preview. */
export function handleMappingSubmit(
  deps: ImportDeps, body: Record<string, any>
): SubmitResult {
  const parsed = parseMappingSubmission(body?.view ?? {});
  if (parsed.error) {
    return {
      ack: {
        response_action: 'errors',
        errors: { [parsed.error.blockId]: parsed.error.message },
      },
    };
  }

  const viewId: string = body?.view?.id ?? '';
  const meta = parsed.meta;

  return {
    ack: {
      response_action: 'update',
      view: importWorkingView(meta, 'Checking for duplicates. Nothing is written yet.'),
    },
    after: async () => {
      try {
        const batch = await getBatch(deps.db, meta.batchId);
        await applyMapping(deps.db, meta.batchId, parsed.mapping as ImportMapping, {
          timeZone: deps.config.timeZone,
        });
        await showPreview(deps, viewId, meta, batch?.filename ?? null);
      } catch (error) {
        await deps.client.views.update({
          view_id: viewId,
          view: importErrorView(meta, explain(error)),
        });
      }
    },
  };
}

/**
 * Step 6: the confirmation.
 *
 * This ack closes the modal rather than holding it open, because an import of
 * thousands of rows outlasts any reasonable modal. The report arrives as a
 * message instead, which is also a durable record rather than something that
 * vanishes when the view closes.
 */
export function handlePreviewSubmit(
  deps: ImportDeps, body: Record<string, any>
): SubmitResult {
  let meta: WizardMeta;
  try {
    meta = JSON.parse(String(body?.view?.private_metadata ?? '{}')) as WizardMeta;
  } catch {
    meta = { batchId: '', channelId: '' };
  }
  const actorId: string | null = body?.user?.id ?? null;

  return {
    ack: { response_action: 'clear' },
    after: async () => {
      const target = meta.channelId || actorId || '';
      try {
        await confirmBatch(deps.db, meta.batchId, { id: actorId });
        const report = await importBatch(deps.db, meta.batchId);
        const check = await verifyBatch(deps.db, meta.batchId);

        await deps.client.chat.postMessage({
          channel: target,
          text: reportText(report, check),
        });
      } catch (error) {
        await deps.client.chat.postMessage({
          channel: target,
          text: `Import failed: ${explain(error)} Nothing was written.`,
        });
      }
    },
  };
}

/**
 * An abandoned wizard marks its batch ABORTED rather than leaving it PARSED
 * forever. Errors are swallowed: a closed modal has nowhere to show one, and a
 * failed abort is a stale row, not a lost task.
 */
export function handleWizardClosed(
  deps: ImportDeps, body: Record<string, any>
): SubmitResult {
  let meta: WizardMeta;
  try {
    meta = JSON.parse(String(body?.view?.private_metadata ?? '{}')) as WizardMeta;
  } catch {
    meta = { batchId: '', channelId: '' };
  }

  return {
    ack: undefined,
    after: async () => {
      if (!meta.batchId) return;
      try {
        const batch = await getBatch(deps.db, meta.batchId);
        // Only an un-imported batch is abandoned. An IMPORTED one is finished,
        // and aborting it would misreport what happened.
        if (batch && ['PARSED', 'MAPPED', 'ANALYZED'].includes(batch.state)) {
          await abortBatch(deps.db, meta.batchId);
        }
      } catch {
        // deliberately ignored, see above
      }
    },
  };
}

async function showPreview(
  deps: ImportDeps, viewId: string, meta: WizardMeta, filename: string | null
): Promise<void> {
  await analyzeBatch(deps.db, meta.batchId);
  const [counts, rows] = await Promise.all([
    verdictCounts(deps.db, meta.batchId),
    getStagedRows(deps.db, meta.batchId, 'READY'),
  ]);
  await deps.client.views.update({
    view_id: viewId,
    view: importPreviewView(meta, counts, rows, { filename }),
  });
}

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Importer errors carry a message meant for a person; anything else does not. */
function explain(error: unknown): string {
  if (
    error instanceof ImportParseError ||
    error instanceof ImportLimitError ||
    error instanceof ImportStateError
  ) {
    return error.message;
  }
  return 'Something went wrong reading that file.';
}

export function reportText(
  report: ImportReport, check: { verified: number; failed: string[] }
): string {
  const lines = [
    `Imported *${report.imported}* task${report.imported === 1 ? '' : 's'}.`,
  ];
  if (report.skipped > 0) lines.push(`Skipped ${report.skipped} as duplicates.`);
  if (report.needsReview > 0) lines.push(`${report.needsReview} need review.`);
  if (report.failed > 0) lines.push(`${report.failed} failed.`);

  // The read-back check is the point of the whole pipeline: it proves the
  // titles in the database are byte-identical to the source.
  lines.push(
    check.failed.length === 0
      ? `Verified ${check.verified} title${check.verified === 1 ? '' : 's'} byte-exact.`
      : `*Verification failed for ${check.failed.length}.* Roll this batch back.`
  );
  lines.push(`Batch \`${report.batchId}\` — roll back with \`pnpm import-tasks rollback\`.`);
  return lines.join('\n');
}

export { NO_CATEGORY };
