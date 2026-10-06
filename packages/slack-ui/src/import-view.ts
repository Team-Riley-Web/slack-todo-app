import type { Space } from '@tr/task-core';
import type {
  ImportSourceType, ImportMapping, Verdict, StagedRow,
} from '@tr/importer';

/**
 * The import wizard, as a native Slack view stack.
 *
 * Three views, which is exactly Slack's stack limit, so there is nothing to
 * spare. Any further step must use `views.update` on the top view rather than
 * a fourth push.
 *
 *   1. upload   file_input + source type
 *   2. mapping  one static_select per unmapped source category (skipped when
 *               every category already resolves)
 *   3. preview  per-verdict counts and the rows, whose submit button is the
 *               ONLY thing that flips a batch to CONFIRMED
 *
 * Nothing here writes a task. The views collect intent; `packages/importer`
 * owns every write, and refuses to import a batch that is not CONFIRMED.
 */

export const IMPORT_CALLBACK_IDS = {
  upload: 'import_upload_modal',
  mapping: 'import_mapping_modal',
  preview: 'import_preview_modal',
  working: 'import_working_modal',
  error: 'import_error_modal',
} as const;

export const IMPORT_BLOCKS = {
  file: 'import_file',
  sourceType: 'import_source_type',
  /** Per-category mapping blocks are `import_map:<index>`, never the raw name. */
  mappingPrefix: 'import_map',
} as const;

export const IMPORT_ACTIONS = {
  file: 'file',
  sourceType: 'source_type',
  space: 'space',
} as const;

/**
 * `filetypes` gates the file picker client-side only. Slack's own type
 * definitions say so: "This validation is provided for convenience only, and
 * you should perform your own file type validation based on what you expect to
 * receive." The server therefore re-sniffs the content and enforces the size
 * and row limits regardless of what the client allowed.
 */
export const IMPORT_FILETYPES = ['csv', 'json'] as const;

/**
 * `kanban` is deliberately absent: its adapter is still aliased to the plain
 * JSON one pending a real sample manifest, so offering it would promise a
 * mapping that does not exist yet.
 */
const SOURCE_TYPES: ReadonlyArray<{ value: ImportSourceType; label: string }> = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
];

export interface UploadMeta {
  channelId: string;
}

export interface WizardMeta {
  batchId: string;
  channelId: string;
  /** Source category names, positionally matched to the mapping block ids. */
  categories?: string[];
}

/**
 * The category `unmappedCategories` reports for rows carrying no source
 * category at all. It is not a real name, so its answer becomes the mapping's
 * `defaultSpace` rather than a `spaces` entry -- `applyMapping` only consults
 * `spaces` for a non-null category, and would ignore an entry keyed on this.
 */
export const NO_CATEGORY = '(none)';

const plain = (text: string) => ({ type: 'plain_text' as const, text });
const mrkdwn = (text: string) => ({ type: 'mrkdwn' as const, text });

/**
 * The label is truncated to Slack's 75-char cap; the value deliberately is
 * not. A truncated value would be a corrupted Space name that `findSpaceExact`
 * silently fails to resolve. Better a loud Slack API error than a mapping that
 * quietly sends rows to the Inbox.
 */
const option = (label: string, value: string) => ({
  text: plain(label.slice(0, 75)),
  value,
});

export function mappingBlockId(index: number): string {
  return `${IMPORT_BLOCKS.mappingPrefix}:${index}`;
}

/** View 1: pick a file and say what it is. */
export function importUploadView(meta: UploadMeta): Record<string, unknown> {
  const typeOptions = SOURCE_TYPES.map((t) => option(t.label, t.value));

  return {
    type: 'modal',
    callback_id: IMPORT_CALLBACK_IDS.upload,
    title: plain('Import tasks'),
    submit: plain('Parse'),
    close: plain('Cancel'),
    // So an abandoned wizard marks its batch ABORTED rather than leaving it
    // PARSED forever.
    notify_on_close: true,
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: 'section',
        text: mrkdwn(
          'Nothing is written until you confirm. Parsing only reads the file ' +
          'and stages it for review.'
        ),
      },
      {
        type: 'input',
        block_id: IMPORT_BLOCKS.sourceType,
        label: plain('What kind of file is this?'),
        element: {
          type: 'radio_buttons',
          action_id: IMPORT_ACTIONS.sourceType,
          options: typeOptions,
          initial_option: typeOptions[0],
        },
      },
      {
        type: 'input',
        block_id: IMPORT_BLOCKS.file,
        label: plain('File'),
        element: {
          type: 'file_input',
          action_id: IMPORT_ACTIONS.file,
          filetypes: [...IMPORT_FILETYPES],
          max_files: 1,
        },
      },
    ],
  };
}

/** View 2: resolve every source category that did not map to a Space. */
export function importMappingView(
  meta: WizardMeta, categories: string[], spaces: Space[]
): Record<string, unknown> {
  // The option VALUE is the Space name, not its id, because `applyMapping`
  // feeds it to `findSpaceExact`. Sending an id here would resolve to nothing
  // and every row would fall through to the Inbox.
  const spaceOptions = spaces.map((s) => option(s.name, s.name));

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: mrkdwn(
        `*${categories.length}* source ${categories.length === 1 ? 'category' : 'categories'}` +
        ' did not match a Space. Choose where each one lands.'
      ),
    },
  ];

  categories.forEach((category, index) => {
    blocks.push({
      type: 'input',
      block_id: mappingBlockId(index),
      // The category name is the LABEL, not the block id: a source name can
      // contain anything, and block ids have to stay parseable.
      label: plain(category.slice(0, 2000)),
      element: {
        type: 'static_select',
        action_id: IMPORT_ACTIONS.space,
        placeholder: plain('Choose a Space'),
        options: spaceOptions,
      },
    });
  });

  return {
    type: 'modal',
    callback_id: IMPORT_CALLBACK_IDS.mapping,
    title: plain('Map categories'),
    submit: plain('Analyze'),
    close: plain('Cancel'),
    notify_on_close: true,
    // Carries the category list so the parser can pair each answer back to its
    // name without trusting block ordering.
    private_metadata: JSON.stringify({ ...meta, categories }),
    blocks,
  };
}

const VERDICT_LABELS: Record<Verdict, string> = {
  READY: 'Will import',
  SKIP_DUPLICATE: 'Skipped as duplicate',
  NEEDS_REVIEW: 'Needs review',
  INVALID: 'Invalid',
};

/** How many example titles the preview lists. Slack caps a view at 100 blocks. */
export const PREVIEW_ROW_LIMIT = 20;

/** View 3: what will happen, and the one button that authorizes it. */
export function importPreviewView(
  meta: WizardMeta,
  counts: Record<Verdict, number>,
  rows: StagedRow[],
  opts: { filename?: string | null } = {}
): Record<string, unknown> {
  const ready = counts.READY;

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: plain(ready === 1 ? '1 task will be created' : `${ready} tasks will be created`),
    },
  ];

  if (opts.filename) {
    blocks.push({ type: 'context', elements: [mrkdwn(`From \`${opts.filename}\``)] });
  }

  // section.fields renders two columns and caps at 10 entries; four verdicts
  // is eight fields, comfortably inside that.
  blocks.push({
    type: 'section',
    fields: (Object.keys(VERDICT_LABELS) as Verdict[]).flatMap((v) => [
      mrkdwn(`*${VERDICT_LABELS[v]}*`),
      mrkdwn(String(counts[v] ?? 0)),
    ]),
  });

  const readyRows = rows.filter((r) => r.verdict === 'READY').slice(0, PREVIEW_ROW_LIMIT);
  if (readyRows.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      // verbatim so a title containing a URL or an @name is shown as written
      // rather than auto-linked into something the user did not type.
      text: {
        type: 'mrkdwn',
        verbatim: true,
        text: readyRows.map((r) => `• ${r.title}`).join('\n').slice(0, 3000),
      },
    });
    if (ready > readyRows.length) {
      blocks.push({
        type: 'context',
        elements: [plain(`and ${ready - readyRows.length} more`)],
      });
    }
  }

  const problems = counts.NEEDS_REVIEW + counts.INVALID;
  if (problems > 0) {
    blocks.push({
      type: 'context',
      elements: [
        mrkdwn(
          `${problems} row${problems === 1 ? '' : 's'} will be skipped and recorded ` +
          'in the import audit. Nothing is lost; re-import after fixing the source.'
        ),
      ],
    });
  }

  return {
    type: 'modal',
    callback_id: IMPORT_CALLBACK_IDS.preview,
    title: plain('Confirm import'),
    // Only present when there is something to write. With nothing READY the
    // view has no submit button at all, so a batch cannot be confirmed into a
    // no-op.
    ...(ready > 0 ? { submit: plain(`Import ${ready}`) } : {}),
    close: plain(ready > 0 ? 'Cancel' : 'Close'),
    notify_on_close: true,
    private_metadata: JSON.stringify(meta),
    blocks,
  };
}

/**
 * The view shown while the server works.
 *
 * `view_submission` has to be acknowledged within 3 seconds, and staging up to
 * MAX_ROWS rows cannot finish in that budget. So each slow step acknowledges
 * immediately with this view and then calls `views.update` when the real work
 * is done.
 *
 * That is a deliberate departure from the spec's `views.push` stack, and it is
 * strictly better here: an update consumes no stack depth, so the wizard is no
 * longer pressed against Slack's three-view ceiling.
 */
export function importWorkingView(
  meta: UploadMeta | WizardMeta, message: string
): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: IMPORT_CALLBACK_IDS.working,
    title: plain('Working'),
    close: plain('Close'),
    notify_on_close: true,
    private_metadata: JSON.stringify(meta),
    blocks: [{ type: 'section', text: mrkdwn(message) }],
  };
}

/** A dead-end view carrying a failure the user needs to read and act on. */
export function importErrorView(
  meta: UploadMeta | WizardMeta, message: string
): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: IMPORT_CALLBACK_IDS.error,
    title: plain('Import failed'),
    close: plain('Close'),
    private_metadata: JSON.stringify(meta),
    blocks: [
      { type: 'section', text: mrkdwn(message) },
      {
        type: 'context',
        elements: [plain('Nothing was written. Fix the file and start again.')],
      },
    ],
  };
}

export interface ParsedUpload {
  meta: UploadMeta;
  sourceType: ImportSourceType;
  /** Slack gives file objects; only the id is needed to fetch the bytes. */
  fileIds: string[];
  error?: { blockId: string; message: string };
}

/**
 * Reads the upload submission.
 *
 * The `file_input` state shape is not in `@slack/types`, so the file list is
 * read through a tolerant chain rather than one assumed path -- the same
 * approach the checkbox reader uses, for the same reason: a wrong guess here
 * fails silently.
 */
export function parseUploadSubmission(view: Record<string, any>): ParsedUpload {
  let meta: UploadMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as UploadMeta;
  } catch {
    meta = { channelId: '' };
  }

  const values = view?.state?.values ?? {};
  const fileState = values?.[IMPORT_BLOCKS.file]?.[IMPORT_ACTIONS.file] ?? {};
  const typeState = values?.[IMPORT_BLOCKS.sourceType]?.[IMPORT_ACTIONS.sourceType] ?? {};

  const rawType = typeState?.selected_option?.value;
  const sourceType: ImportSourceType =
    rawType === 'csv' || rawType === 'json'
      ? rawType
      : 'csv';

  const fileIds = readFileIds(fileState);
  if (fileIds.length === 0) {
    return {
      meta, sourceType, fileIds: [],
      error: { blockId: IMPORT_BLOCKS.file, message: 'Attach one CSV or JSON file.' },
    };
  }
  if (fileIds.length > 1) {
    return {
      meta, sourceType, fileIds,
      error: {
        blockId: IMPORT_BLOCKS.file,
        message: 'One file at a time, so a rollback maps to one batch.',
      },
    };
  }

  return { meta, sourceType, fileIds };
}

function readFileIds(state: Record<string, any>): string[] {
  const candidates = [state?.files, state?.selected_files, state?.value];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const ids = candidate
      .map((f) => (typeof f === 'string' ? f : f?.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) return ids;
  }
  return [];
}

export interface ParsedMapping {
  meta: WizardMeta;
  mapping: ImportMapping;
  error?: { blockId: string; message: string };
}

/**
 * Reads the mapping submission into an ImportMapping.
 *
 * Answers are paired to category names by index through `private_metadata`,
 * not by parsing a name out of a block id -- a source category can contain a
 * colon, or anything else.
 */
export function parseMappingSubmission(view: Record<string, any>): ParsedMapping {
  let meta: WizardMeta;
  try {
    meta = JSON.parse(String(view?.private_metadata ?? '{}')) as WizardMeta;
  } catch {
    meta = { batchId: '', channelId: '' };
  }

  const categories = Array.isArray(meta.categories) ? meta.categories : [];
  const values = view?.state?.values ?? {};
  const spaces: Record<string, string> = {};
  let defaultSpace: string | null = null;

  for (let i = 0; i < categories.length; i += 1) {
    const selected =
      values?.[mappingBlockId(i)]?.[IMPORT_ACTIONS.space]?.selected_option?.value;
    if (typeof selected !== 'string' || selected.length === 0) {
      return {
        meta,
        mapping: {},
        error: {
          blockId: mappingBlockId(i),
          message: 'Choose a Space for this category.',
        },
      };
    }
    const category = categories[i]!;
    // Rows with no category are steered by defaultSpace; a spaces entry keyed
    // on the sentinel would never be consulted.
    if (category === NO_CATEGORY) defaultSpace = selected;
    else spaces[category] = selected;
  }

  return {
    meta,
    mapping: defaultSpace === null ? { spaces } : { spaces, defaultSpace },
  };
}
