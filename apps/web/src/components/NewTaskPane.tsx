import Link from 'next/link';
import type { Space } from '@tr/task-core';
import { createTaskFormVoid } from '@/actions/tasks';
import { closeNewTaskHref } from '@/lib/display';
import { SpaceSelect } from '@/components/SpaceSelect';

/** New-task capture in the same URL-driven right pane used for editing. */
export function NewTaskPane({
  spaces, defaultSpaceSlug, basePath, params,
}: {
  spaces: Space[];
  defaultSpaceSlug?: string;
  basePath: string;
  params: Record<string, string | string[] | undefined>;
}) {
  const back = closeNewTaskHref(basePath, params);
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <>
      <Link className="pane-backdrop" href={back} aria-label="Close" />

      <aside className="pane" aria-label="New task">
        <header className="pane-head">
          <h2>New task</h2>
          <Link className="pane-close" href={back} aria-label="Close">×</Link>
        </header>

        {error ? <p className="error">{String(error)}</p> : null}

        <form className="stack" action={createTaskFormVoid}>
          <input type="hidden" name="returnTo" value={back} />

          <label>
            Title
            <input
              type="text"
              name="title"
              required
              autoFocus
              placeholder="Exactly as you would type it"
              aria-label="Task title"
            />
          </label>

          <label>
            Space
            <SpaceSelect
              name="spaceSlug"
              spaces={spaces}
              valueOf={(space) => space.slug}
              defaultValue={defaultSpaceSlug}
              required
              ariaLabel="Space"
            />
          </label>

          <label>
            Due
            <input type="datetime-local" name="dueAt" />
          </label>

          <div className="filters">
            <button type="submit" className="primary">Create task</button>
            <Link className="btn" href={back}>Cancel</Link>
          </div>
        </form>
      </aside>
    </>
  );
}
