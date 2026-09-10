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
  due_at: Date | null;
  waiting_on: string | null;
  details: string | null;
  created_at: Date;
  completed_at: Date | null;
  source_platform: string;
  source_channel_id: string | null;
  source_message_ts: string | null;
  created_by: string | null;
}
