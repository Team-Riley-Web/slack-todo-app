import type { TaskStatus } from '@tr/task-core';

export type ImportSourceType = 'csv' | 'json' | 'workast' | 'kanban';

export type Verdict = 'READY' | 'SKIP_DUPLICATE' | 'NEEDS_REVIEW' | 'INVALID';

export type BatchState =
  | 'PARSED' | 'MAPPED' | 'ANALYZED' | 'CONFIRMED' | 'IMPORTED'
  | 'ROLLED_BACK' | 'ABORTED';

export type AuditAction =
  | 'IMPORTED' | 'SKIPPED_DUPLICATE' | 'NEEDS_REVIEW' | 'FAILED' | 'ROLLED_BACK';

/**
 * One source record, normalized.
 *
 * `title` holds the source bytes and is never rewritten by any later step:
 * mapping resolves into the `resolved_*` columns and leaves this alone.
 */
export interface StagingRow {
  rowNumber: number;
  sourceType: ImportSourceType;
  sourceRecordId: string | null;
  title: string;
  space: string | null;
  listState: string | null;
  assignee: string | null;
  dueAt: string | null;
  waitingOn: string | null;
  createdAt: string | null;
  completedAt: string | null;
  status: string | null;
  sourceMetadata: Record<string, unknown>;
}

/** Pure: bytes in, staging rows out. No database, no network. */
export type Adapter = (input: string) => StagingRow[];

export interface ImportMapping {
  spaces?: Record<string, string>;
  assignees?: Record<string, string>;
  statuses?: Record<string, TaskStatus>;
  lists?: Record<string, string>;
  defaultSpace?: string | null;
}

export interface ImportBatch {
  id: string;
  source_type: ImportSourceType;
  filename: string | null;
  state: BatchState;
  mapping: ImportMapping;
  row_count: number;
  created_by: string | null;
  created_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  imported_at: Date | null;
  rolled_back_at: Date | null;
}

export interface StagedRow {
  id: string;
  batch_id: string;
  row_number: number;
  source_type: ImportSourceType;
  source_record_id: string | null;
  title: string;
  space: string | null;
  list_state: string | null;
  assignee: string | null;
  due_at: string | null;
  waiting_on: string | null;
  created_at: string | null;
  completed_at: string | null;
  status: string | null;
  source_metadata: Record<string, unknown>;
  resolved_space_id: string | null;
  resolved_assignee_id: string | null;
  resolved_status: TaskStatus | null;
  resolved_due_at: Date | null;
  resolved_created_at: Date | null;
  resolved_completed_at: Date | null;
  idempotency_key: string | null;
  verdict: Verdict | null;
  reason: string | null;
  duplicate_task_id: string | null;
  canonical_task_id: string | null;
}

export interface AuditRow {
  id: string;
  batch_id: string;
  source_type: ImportSourceType;
  source_record_id: string | null;
  canonical_task_id: string | null;
  action: AuditAction;
  reason: string | null;
  created_at: Date;
}
