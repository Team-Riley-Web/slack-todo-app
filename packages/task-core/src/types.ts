import type { Priority } from './priority.js';

export type TaskStatus = 'open' | 'waiting' | 'completed';

export interface Space {
  id: string;
  name: string;
  slug: string;
  is_inbox: boolean;
}

export interface Task {
  id: string;
  title: string;
  space_id: string;
  list_id: string | null;
  assignee_id: string | null;
  status: TaskStatus;
  /** P0-P3, or null for Unprioritized. Sorts last when null. */
  priority: Priority | null;
  due_at: Date | null;
  waiting_on: string | null;
  details: string | null;
  created_at: Date;
  completed_at: Date | null;
  source_platform: string;
  source_channel_id: string | null;
  source_message_ts: string | null;
  created_by: string | null;
  /** Set only on imported tasks. The idempotency key for its source record. */
  source_external_id: string | null;
  /** Set only on imported tasks. Which import batch created it. */
  import_batch_id: string | null;
}
