import { describe, it, expect } from 'vitest';
import type { Space } from '@tr/task-core';
import type { StagedRow, Verdict } from '@tr/importer';
import {
  importUploadView, importMappingView, importPreviewView,
  parseUploadSubmission, parseMappingSubmission,
  mappingBlockId, IMPORT_BLOCKS, IMPORT_ACTIONS, IMPORT_CALLBACK_IDS,
  NO_CATEGORY, PREVIEW_ROW_LIMIT,
} from './import-view.js';

const SPACES: Space[] = [
  { id: 'S_INBOX', name: 'Inbox', slug: 'inbox', is_inbox: true },
  { id: 'S_MKT', name: 'Marketing', slug: 'marketing', is_inbox: false },
  { id: 'S_MILL', name: 'Client - Milltown Cabinets', slug: 'milltown-cabinets', is_inbox: false },
] as unknown as Space[];

const blocksOf = (view: Record<string, unknown>): Record<string, any>[] =>
  view.blocks as Record<string, any>[];

const blockById = (view: Record<string, unknown>, id: string): Record<string, any> =>
  blocksOf(view).find((b) => b.block_id === id)!;

const counts = (over: Partial<Record<Verdict, number>> = {}): Record<Verdict, number> => ({
  READY: 0, SKIP_DUPLICATE: 0, NEEDS_REVIEW: 0, INVALID: 0, ...over,
});

const stagedRow = (title: string, verdict: Verdict = 'READY'): StagedRow =>
  ({ title, verdict }) as unknown as StagedRow;

describe('the upload view', () => {
  const view = importUploadView({ channelId: 'C1' });

  it('puts the file input in an input block, the only kind that reaches state', () => {
    const block = blockById(view, IMPORT_BLOCKS.file);
    expect(block.type).toBe('input');
    expect(block.element.type).toBe('file_input');
  });

  it('accepts exactly one file, so a rollback maps to one batch', () => {
    expect(blockById(view, IMPORT_BLOCKS.file).element.max_files).toBe(1);
  });

  it('hints csv and json to the picker without relying on it', () => {
    expect(blockById(view, IMPORT_BLOCKS.file).element.filetypes).toEqual(['csv', 'json']);
  });

  it('asks the source type natively rather than sniffing it', () => {
    const block = blockById(view, IMPORT_BLOCKS.sourceType);
    expect(block.element.type).toBe('radio_buttons');
    expect(block.element.options.map((o: any) => o.value)).toEqual(['csv', 'json']);
  });

  it('reuses the same option object for initial_option, which Slack matches by identity', () => {
    const el = blockById(view, IMPORT_BLOCKS.sourceType).element;
    expect(el.initial_option).toBe(el.options[0]);
  });

  it('does not offer kanban, whose adapter is still a JSON alias', () => {
    const values = blockById(view, IMPORT_BLOCKS.sourceType).element.options
      .map((o: any) => o.value);
    expect(values).not.toContain('kanban');
  });

  it('asks to be notified on close so an abandoned batch can be aborted', () => {
    expect(view.notify_on_close).toBe(true);
  });
});

describe('the mapping view', () => {
  const meta = { batchId: 'B1', channelId: 'C1' };

  it('offers Space NAMES as values, because applyMapping resolves by name', () => {
    // The bug this pins: sending space ids made findSpaceExact resolve
    // nothing, and every row fell through to the Inbox.
    const view = importMappingView(meta, ['Personal tasks'], SPACES);
    const options = blockById(view, mappingBlockId(0)).element.options;
    expect(options.map((o: any) => o.value)).toEqual([
      'Inbox', 'Marketing', 'Client - Milltown Cabinets',
    ]);
  });

  it('never truncates an option value, only its label', () => {
    const long = 'x'.repeat(120);
    const spaces = [{ id: 'S', name: long, slug: 's', is_inbox: false }] as unknown as Space[];
    const option = blockById(
      importMappingView(meta, ['c'], spaces), mappingBlockId(0)
    ).element.options[0];
    expect(option.value).toBe(long);
    expect(option.text.text).toHaveLength(75);
  });

  it('carries the category name in the label, not the block id', () => {
    const view = importMappingView(meta, ['weird: name / with things'], SPACES);
    const block = blockById(view, mappingBlockId(0));
    expect(block.block_id).toBe('import_map:0');
    expect(block.label.text).toBe('weird: name / with things');
  });

  it('records the categories in private_metadata so answers pair back by index', () => {
    const view = importMappingView(meta, ['a', 'b'], SPACES);
    expect(JSON.parse(String(view.private_metadata))).toEqual({
      batchId: 'B1', channelId: 'C1', categories: ['a', 'b'],
    });
  });

  it('makes one input block per category', () => {
    const view = importMappingView(meta, ['a', 'b', 'c'], SPACES);
    const inputs = blocksOf(view).filter((b) => b.type === 'input');
    expect(inputs).toHaveLength(3);
  });
});

describe('the preview view', () => {
  const meta = { batchId: 'B1', channelId: 'C1' };

  it('reports every verdict count', () => {
    const view = importPreviewView(
      meta, counts({ READY: 3, SKIP_DUPLICATE: 2, NEEDS_REVIEW: 1, INVALID: 4 }), []
    );
    const fields = blocksOf(view).find((b) => b.fields)!.fields.map((f: any) => f.text);
    expect(fields).toContain('3');
    expect(fields).toContain('2');
    expect(fields).toContain('1');
    expect(fields).toContain('4');
  });

  it('has no submit button when nothing is ready, so a no-op cannot be confirmed', () => {
    const view = importPreviewView(meta, counts({ SKIP_DUPLICATE: 5 }), []);
    expect(view.submit).toBeUndefined();
    expect((view.close as any).text).toBe('Close');
  });

  it('labels the submit button with the exact number it will write', () => {
    const view = importPreviewView(meta, counts({ READY: 7 }), []);
    expect((view.submit as any).text).toBe('Import 7');
  });

  it('lists ready titles verbatim, so a title with a URL is not auto-linked', () => {
    const view = importPreviewView(
      meta, counts({ READY: 1 }), [stagedRow('Email hello@example.com re: #plan')]
    );
    const section = blocksOf(view).find((b) => b.text?.verbatim === true)!;
    expect(section.text.text).toContain('Email hello@example.com re: #plan');
  });

  it('shows only ready rows in the list', () => {
    const view = importPreviewView(meta, counts({ READY: 1, INVALID: 1 }), [
      stagedRow('keep me', 'READY'),
      stagedRow('drop me', 'INVALID'),
    ]);
    const section = blocksOf(view).find((b) => b.text?.verbatim === true)!;
    expect(section.text.text).toContain('keep me');
    expect(section.text.text).not.toContain('drop me');
  });

  it('caps the list and says how many more there are', () => {
    const rows = Array.from({ length: 50 }, (_, i) => stagedRow(`task ${i}`));
    const view = importPreviewView(meta, counts({ READY: 50 }), rows);
    const section = blocksOf(view).find((b) => b.text?.verbatim === true)!;
    expect(section.text.text.split('\n')).toHaveLength(PREVIEW_ROW_LIMIT);
    const context = blocksOf(view).filter((b) => b.type === 'context');
    expect(JSON.stringify(context)).toContain(`and ${50 - PREVIEW_ROW_LIMIT} more`);
  });

  it('stays inside Slack 100-block cap even at the row limit', () => {
    const rows = Array.from({ length: 500 }, (_, i) => stagedRow(`task ${i}`));
    const view = importPreviewView(meta, counts({ READY: 500 }), rows);
    expect(blocksOf(view).length).toBeLessThanOrEqual(100);
  });
});

describe('parsing the upload submission', () => {
  const submission = (fileState: unknown, type = 'csv') => ({
    private_metadata: JSON.stringify({ channelId: 'C1' }),
    state: {
      values: {
        [IMPORT_BLOCKS.file]: { [IMPORT_ACTIONS.file]: fileState },
        [IMPORT_BLOCKS.sourceType]: {
          [IMPORT_ACTIONS.sourceType]: { selected_option: { value: type } },
        },
      },
    },
  });

  it('reads the documented files array of file objects', () => {
    const parsed = parseUploadSubmission(submission({ files: [{ id: 'F1', name: 'a.csv' }] }));
    expect(parsed.fileIds).toEqual(['F1']);
    expect(parsed.error).toBeUndefined();
  });

  it('tolerates the shape being a bare id array', () => {
    expect(parseUploadSubmission(submission({ files: ['F9'] })).fileIds).toEqual(['F9']);
  });

  it('tolerates selected_files, in case that is what arrives', () => {
    expect(
      parseUploadSubmission(submission({ selected_files: [{ id: 'F7' }] })).fileIds
    ).toEqual(['F7']);
  });

  it('errors on the file block when nothing was attached', () => {
    const parsed = parseUploadSubmission(submission({ files: [] }));
    expect(parsed.error?.blockId).toBe(IMPORT_BLOCKS.file);
  });

  it('errors rather than silently importing only the first of several files', () => {
    const parsed = parseUploadSubmission(
      submission({ files: [{ id: 'F1' }, { id: 'F2' }] })
    );
    expect(parsed.error?.blockId).toBe(IMPORT_BLOCKS.file);
    expect(parsed.error?.message).toContain('One file at a time');
  });

  it('reads the chosen source type', () => {
    expect(parseUploadSubmission(submission({ files: [{ id: 'F' }] }, 'json')).sourceType)
      .toBe('json');
  });

  it('falls back to csv rather than trusting an unknown source type', () => {
    expect(
      parseUploadSubmission(submission({ files: [{ id: 'F' }] }, 'evil')).sourceType
    ).toBe('csv');
  });

  it('survives absent metadata without throwing', () => {
    expect(parseUploadSubmission({}).error).toBeDefined();
  });
});

describe('parsing the mapping submission', () => {
  const submission = (categories: string[], picks: Array<string | null>) => ({
    private_metadata: JSON.stringify({ batchId: 'B1', channelId: 'C1', categories }),
    state: {
      values: Object.fromEntries(
        picks.map((p, i) => [
          mappingBlockId(i),
          { [IMPORT_ACTIONS.space]: p === null ? {} : { selected_option: { value: p } } },
        ])
      ),
    },
  });

  it('pairs each answer to its category by index', () => {
    const parsed = parseMappingSubmission(
      submission(['Personal tasks', 'Music'], ['Personal', 'Music'])
    );
    expect(parsed.mapping.spaces).toEqual({
      'Personal tasks': 'Personal', Music: 'Music',
    });
    expect(parsed.error).toBeUndefined();
  });

  it('pairs correctly even when a category name contains a colon', () => {
    const parsed = parseMappingSubmission(submission(['a:b:c'], ['Marketing']));
    expect(parsed.mapping.spaces).toEqual({ 'a:b:c': 'Marketing' });
  });

  it('routes the no-category sentinel to defaultSpace, not a spaces entry', () => {
    // applyMapping only consults `spaces` for a non-null category, so an entry
    // keyed on '(none)' would be silently ignored.
    const parsed = parseMappingSubmission(submission([NO_CATEGORY], ['Inbox']));
    expect(parsed.mapping.defaultSpace).toBe('Inbox');
    expect(parsed.mapping.spaces).toEqual({});
  });

  it('handles a real category and the sentinel together', () => {
    const parsed = parseMappingSubmission(
      submission(['Music', NO_CATEGORY], ['Music', 'Inbox'])
    );
    expect(parsed.mapping).toEqual({ spaces: { Music: 'Music' }, defaultSpace: 'Inbox' });
  });

  it('omits defaultSpace entirely when the sentinel was not present', () => {
    const parsed = parseMappingSubmission(submission(['Music'], ['Music']));
    expect('defaultSpace' in parsed.mapping).toBe(false);
  });

  it('errors on the specific block left unanswered', () => {
    const parsed = parseMappingSubmission(submission(['a', 'b'], ['Inbox', null]));
    expect(parsed.error?.blockId).toBe(mappingBlockId(1));
    expect(parsed.mapping.spaces).toBeUndefined();
  });

  it('carries the batch id through', () => {
    expect(parseMappingSubmission(submission(['a'], ['Inbox'])).meta.batchId).toBe('B1');
  });

  it('has a callback id distinct from the other two views', () => {
    const ids = Object.values(IMPORT_CALLBACK_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
