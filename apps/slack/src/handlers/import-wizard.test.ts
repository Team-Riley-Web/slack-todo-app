import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@tr/db/testing';
import type { Db } from '@tr/db';
import { getBatch, listBatches } from '@tr/importer';
import { IMPORT_BLOCKS, IMPORT_ACTIONS, IMPORT_CALLBACK_IDS, mappingBlockId } from '@tr/slack-ui';
import {
  handleImportCommand, handleUploadSubmit, handleMappingSubmit,
  handlePreviewSubmit, handleWizardClosed, reportText,
  type ImportDeps, type FetchedFile,
} from './import-wizard.js';
import type { AppConfig } from '../config.js';

const CONFIG: AppConfig = {
  teamId: 'T1',
  authorizedUserIds: ['U_JOSH'],
  defaultAssigneeId: null,
  assigneeLabels: {},
  timeZone: 'America/Chicago',
  mode: 'socket',
};

interface Recorder {
  opened: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  posted: Record<string, unknown>[];
}

let db: Db;
let rec: Recorder;
let file: FetchedFile;
let deps: ImportDeps;

const CSV = [
  'title,space,status',
  'Offer Neil Instagram and Facebook package for $100,Marketing,open',
  'Consolidate 401(k): move Corebridge to Fidelity,Personal,open',
].join('\n');

beforeEach(async () => {
  db = await createTestDb();
  rec = { opened: [], updated: [], posted: [] };
  file = { name: 'export.csv', size: CSV.length, text: CSV };
  deps = {
    db,
    config: CONFIG,
    client: {
      views: {
        open: async (a) => { rec.opened.push(a); return {}; },
        update: async (a) => { rec.updated.push(a); return {}; },
      },
      chat: {
        postMessage: async (a) => { rec.posted.push(a); return {}; },
      },
    },
    fetchFile: async () => file,
  };
});
afterEach(async () => { await db.close(); });

const lastView = (): Record<string, any> =>
  rec.updated[rec.updated.length - 1]!.view as Record<string, any>;

const uploadBody = (over: { fileId?: string; type?: string } = {}) => ({
  user: { id: 'U_JOSH' },
  team: { id: 'T1' },
  view: {
    id: 'V1',
    private_metadata: JSON.stringify({ channelId: 'C1' }),
    state: {
      values: {
        [IMPORT_BLOCKS.file]: {
          [IMPORT_ACTIONS.file]: {
            files: over.fileId === undefined ? [{ id: 'F1' }] : [{ id: over.fileId }],
          },
        },
        [IMPORT_BLOCKS.sourceType]: {
          [IMPORT_ACTIONS.sourceType]: { selected_option: { value: over.type ?? 'csv' } },
        },
      },
    },
  },
});

const countTasks = async (): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks`);
  return rows[0]!.n;
};

describe('/import', () => {
  it('opens the upload view', async () => {
    const result = await handleImportCommand(deps, {
      team_id: 'T1', user_id: 'U_JOSH', channel_id: 'C1', trigger_id: 'TR',
    });
    expect(result.outcome).toBe('opened');
    expect((rec.opened[0]!.view as any).callback_id).toBe(IMPORT_CALLBACK_IDS.upload);
  });

  it('refuses an unauthorized user and opens nothing', async () => {
    const result = await handleImportCommand(deps, {
      team_id: 'T1', user_id: 'U_STRANGER', channel_id: 'C1', trigger_id: 'TR',
    });
    expect(result.outcome).toBe('unauthorized');
    expect(rec.opened).toHaveLength(0);
  });

  it('refuses another workspace even with a known user id', async () => {
    const result = await handleImportCommand(deps, {
      team_id: 'T_OTHER', user_id: 'U_JOSH', channel_id: 'C1', trigger_id: 'TR',
    });
    expect(result.outcome).toBe('unauthorized');
  });
});

describe('the upload step', () => {
  it('acks within the budget before doing any work', () => {
    // The ack is returned synchronously; the slow part is the continuation.
    const result = handleUploadSubmit(deps, uploadBody());
    expect(result.ack).toEqual({
      response_action: 'update',
      view: expect.objectContaining({ callback_id: IMPORT_CALLBACK_IDS.working }),
    });
    expect(result.after).toBeInstanceOf(Function);
  });

  it('returns a field error and no continuation when no file was attached', () => {
    const body = uploadBody();
    (body.view.state.values as any)[IMPORT_BLOCKS.file][IMPORT_ACTIONS.file] = { files: [] };
    const result = handleUploadSubmit(deps, body);
    expect(result.ack).toEqual({
      response_action: 'errors',
      errors: { [IMPORT_BLOCKS.file]: expect.stringContaining('one CSV or JSON') },
    });
    expect(result.after).toBeUndefined();
  });

  it('stages the file and goes straight to the preview when everything maps', async () => {
    const result = handleUploadSubmit(deps, uploadBody());
    await result.after!();

    const view = lastView();
    expect(view.callback_id).toBe(IMPORT_CALLBACK_IDS.preview);
    expect(view.submit.text).toBe('Import 2');

    const batches = await listBatches(db);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.state).toBe('ANALYZED');
    expect(batches[0]!.filename).toBe('export.csv');
    expect(batches[0]!.created_by).toBe('U_JOSH');
  });

  it('writes no task before confirmation', async () => {
    await handleUploadSubmit(deps, uploadBody()).after!();
    expect(await countTasks()).toBe(0);
  });

  it('asks about categories that match no Space', async () => {
    file = {
      name: 'x.csv', size: 100,
      text: 'title,space\nSomething,Nonexistent Client\n',
    };
    await handleUploadSubmit(deps, uploadBody()).after!();

    const view = lastView();
    expect(view.callback_id).toBe(IMPORT_CALLBACK_IDS.mapping);
    expect(view.blocks.find((b: any) => b.block_id === mappingBlockId(0)).label.text)
      .toBe('Nonexistent Client');
  });

  it('shows an error view and creates no batch when the type disagrees with the bytes', async () => {
    // The importer's assertWithinLimits owns this rule, not the handler.
    await handleUploadSubmit(deps, uploadBody({ type: 'json' })).after!();
    expect(lastView().callback_id).toBe(IMPORT_CALLBACK_IDS.error);
    expect(JSON.stringify(lastView()))
      .toContain('declared json but the contents look like csv');
    expect(await listBatches(db)).toHaveLength(0);
  });

  it('refuses an oversized file on its metadata, before parsing it', async () => {
    file = { name: 'huge.csv', size: 11 * 1024 * 1024, text: CSV };
    await handleUploadSubmit(deps, uploadBody()).after!();
    expect(lastView().callback_id).toBe(IMPORT_CALLBACK_IDS.error);
    expect(JSON.stringify(lastView())).toContain('the limit is');
    expect(await listBatches(db)).toHaveLength(0);
  });

  it('rejects a file that parses but holds no rows', async () => {
    file = { name: 'empty.csv', size: 12, text: 'title,space\n' };
    await handleUploadSubmit(deps, uploadBody()).after!();
    expect(lastView().callback_id).toBe(IMPORT_CALLBACK_IDS.error);
    expect(JSON.stringify(lastView())).toContain('no rows');
  });

  it('does not leak an internal error message to the user', async () => {
    deps.fetchFile = async () => { throw new Error('ECONNRESET tok=xoxb-secret'); };
    await handleUploadSubmit(deps, uploadBody()).after!();
    const text = JSON.stringify(lastView());
    expect(text).not.toContain('xoxb-secret');
    expect(text).toContain('Something went wrong');
  });
});

describe('the mapping step', () => {
  const mappingBody = (batchId: string, pick: string | null) => ({
    user: { id: 'U_JOSH' },
    view: {
      id: 'V1',
      private_metadata: JSON.stringify({
        batchId, channelId: 'C1', categories: ['Nonexistent Client'],
      }),
      state: {
        values: {
          [mappingBlockId(0)]: {
            [IMPORT_ACTIONS.space]: pick === null ? {} : { selected_option: { value: pick } },
          },
        },
      },
    },
  });

  const stageUnmapped = async (): Promise<string> => {
    file = { name: 'x.csv', size: 100, text: 'title,space\nSomething,Nonexistent Client\n' };
    await handleUploadSubmit(deps, uploadBody()).after!();
    return (await listBatches(db))[0]!.id;
  };

  it('applies the chosen Space and moves to the preview', async () => {
    const batchId = await stageUnmapped();
    const result = handleMappingSubmit(deps, mappingBody(batchId, 'Marketing'));
    await result.after!();

    expect(lastView().callback_id).toBe(IMPORT_CALLBACK_IDS.preview);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM import_staging s
        JOIN spaces sp ON sp.id = s.resolved_space_id
       WHERE s.batch_id = $1 AND sp.name = 'Marketing'`,
      [batchId]
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('errors on the unanswered block without touching the batch', async () => {
    const batchId = await stageUnmapped();
    const result = handleMappingSubmit(deps, mappingBody(batchId, null));
    expect(result.ack).toEqual({
      response_action: 'errors',
      errors: { [mappingBlockId(0)]: expect.stringContaining('Choose a Space') },
    });
    expect(result.after).toBeUndefined();
    expect((await getBatch(db, batchId))!.state).toBe('MAPPED');
  });

  it('still writes no task', async () => {
    const batchId = await stageUnmapped();
    await handleMappingSubmit(deps, mappingBody(batchId, 'Marketing')).after!();
    expect(await countTasks()).toBe(0);
  });

  it('keeps the filename on the preview across the mapping step', async () => {
    const batchId = await stageUnmapped();
    await handleMappingSubmit(deps, mappingBody(batchId, 'Marketing')).after!();
    expect(JSON.stringify(lastView())).toContain('x.csv');
  });
});

describe('the confirmation step', () => {
  const previewBody = (batchId: string, channelId = 'C1') => ({
    user: { id: 'U_JOSH' },
    view: { id: 'V1', private_metadata: JSON.stringify({ batchId, channelId }) },
  });

  const staged = async (): Promise<string> => {
    await handleUploadSubmit(deps, uploadBody()).after!();
    return (await listBatches(db))[0]!.id;
  };

  it('closes the modal immediately rather than holding it through the import', async () => {
    const batchId = await staged();
    expect(handlePreviewSubmit(deps, previewBody(batchId)).ack)
      .toEqual({ response_action: 'clear' });
  });

  it('imports the tasks and reports byte-exact verification', async () => {
    const batchId = await staged();
    await handlePreviewSubmit(deps, previewBody(batchId)).after!();

    expect(await countTasks()).toBe(2);
    const text = String(rec.posted[0]!.text);
    expect(text).toContain('Imported *2* tasks');
    expect(text).toContain('Verified 2 titles byte-exact');
    expect(text).toContain(batchId);
  });

  it('stores the title byte-exact, dollar sign and parentheses included', async () => {
    const batchId = await staged();
    await handlePreviewSubmit(deps, previewBody(batchId)).after!();

    const { rows } = await db.query<{ title: string }>(
      `SELECT title FROM tasks ORDER BY title`
    );
    expect(rows.map((r) => r.title)).toEqual([
      'Consolidate 401(k): move Corebridge to Fidelity',
      'Offer Neil Instagram and Facebook package for $100',
    ]);
  });

  it('records who confirmed it', async () => {
    const batchId = await staged();
    await handlePreviewSubmit(deps, previewBody(batchId)).after!();
    const batch = await getBatch(db, batchId);
    expect(batch!.state).toBe('IMPORTED');
    expect(batch!.confirmed_by).toBe('U_JOSH');
  });

  it('reports a failure and writes nothing when the batch is not ANALYZED', async () => {
    // A batch straight from upload with no analyze step cannot be confirmed.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO import_batches (source_type, filename) VALUES ('csv','x.csv')
       RETURNING id`
    );
    await handlePreviewSubmit(deps, previewBody(rows[0]!.id)).after!();
    expect(String(rec.posted[0]!.text)).toContain('Import failed');
    expect(await countTasks()).toBe(0);
  });

  it('falls back to a DM when the wizard was opened outside a channel', async () => {
    const batchId = await staged();
    await handlePreviewSubmit(deps, previewBody(batchId, '')).after!();
    expect(rec.posted[0]!.channel).toBe('U_JOSH');
  });
});

describe('abandoning the wizard', () => {
  const closeBody = (batchId: string) => ({
    view: { private_metadata: JSON.stringify({ batchId, channelId: 'C1' }) },
  });

  it('marks a staged batch ABORTED rather than leaving it forever', async () => {
    await handleUploadSubmit(deps, uploadBody()).after!();
    const batchId = (await listBatches(db))[0]!.id;

    await handleWizardClosed(deps, closeBody(batchId)).after!();
    expect((await getBatch(db, batchId))!.state).toBe('ABORTED');
  });

  it('leaves an already imported batch alone', async () => {
    await handleUploadSubmit(deps, uploadBody()).after!();
    const batchId = (await listBatches(db))[0]!.id;
    await handlePreviewSubmit(deps, { user: { id: 'U_JOSH' }, view: { private_metadata: JSON.stringify({ batchId, channelId: 'C1' }) } }).after!();

    await handleWizardClosed(deps, closeBody(batchId)).after!();
    expect((await getBatch(db, batchId))!.state).toBe('IMPORTED');
  });

  it('does nothing when the closed view carried no batch', async () => {
    const result = handleWizardClosed(deps, { view: { private_metadata: '{}' } });
    await expect(result.after!()).resolves.toBeUndefined();
  });

  it('survives unparseable metadata', async () => {
    const result = handleWizardClosed(deps, { view: { private_metadata: 'not json' } });
    await expect(result.after!()).resolves.toBeUndefined();
  });

  it('acks a view_closed with nothing, which is what Slack expects', () => {
    expect(handleWizardClosed(deps, closeBody('x')).ack).toBeUndefined();
  });
});

describe('the report message', () => {
  it('tells the user to roll back when verification failed', () => {
    const text = reportText(
      {
        batchId: 'B1', imported: 3, skipped: 0, needsReview: 0, failed: 0,
        records: [], importedAt: '2026-09-10T00:00:00.000Z',
      },
      { verified: 2, failed: ['T_BAD'] }
    );
    expect(text).toContain('Verification failed for 1');
    expect(text).toContain('Roll this batch back');
  });

  it('mentions skipped duplicates only when there were some', () => {
    const base = {
      batchId: 'B1', imported: 1, skipped: 0, needsReview: 0, failed: 0,
      records: [], importedAt: '2026-09-10T00:00:00.000Z',
    };
    expect(reportText(base, { verified: 1, failed: [] })).not.toContain('Skipped');
    expect(reportText({ ...base, skipped: 4 }, { verified: 1, failed: [] }))
      .toContain('Skipped 4 as duplicates');
  });

  it('uses the singular for one task', () => {
    const text = reportText(
      {
        batchId: 'B1', imported: 1, skipped: 0, needsReview: 0, failed: 0,
        records: [], importedAt: '2026-09-10T00:00:00.000Z',
      },
      { verified: 1, failed: [] }
    );
    expect(text).toContain('Imported *1* task.');
    expect(text).toContain('Verified 1 title byte-exact');
  });
});
