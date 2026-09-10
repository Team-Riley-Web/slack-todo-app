import { createTaskFormVoid } from '@/actions/tasks';

/**
 * Adding a task from the web.
 *
 * The title is submitted as a plain form field and stored byte-exact, exactly
 * as `/task` does in Slack. Nothing is required except the title.
 */
export function NewTaskForm({
  spaceSlug, error,
}: {
  spaceSlug: string;
  error?: string;
}) {
  return (
    <>
    {error ? <p className="error">{error}</p> : null}
    <form className="inline" action={createTaskFormVoid}>
      <input type="hidden" name="spaceSlug" value={spaceSlug} />
      <label className="small">
        New task
        <input
          type="text"
          name="title"
          required
          placeholder="Exactly as you would type it"
          aria-label="Task title"
          size={36}
        />
      </label>
      <label className="small">
        Due
        <input type="datetime-local" name="dueAt" aria-label="Due date and time" />
      </label>
      <button type="submit" className="primary">Add</button>
    </form>
    </>
  );
}
