import { getDb } from '@/db';
import { spaceSummary } from '@/data/tasks';
import { requireUser } from '@/user';
import { settingsView } from '@/operations/settings';
import {
  setChannelMappingFormVoid, removeChannelMappingFormVoid,
} from '@/actions/settings';
import { Shell } from '@/components/Shell';
import { SpaceSelect } from '@/components/SpaceSelect';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { error } = await searchParams;
  const db = await getDb();
  const view = await settingsView(db);
  const railSpaces = (await spaceSummary(db)).map(({ space, open, waiting }) => ({
    space, open, waiting,
  }));

  return (
    <Shell
      current="/settings"
      who={user.name ?? user.slackUserId}
      spaces={railSpaces}
      title="Settings"
    >
      <p className="muted small">
        No tokens or keys are shown here, or read by this page at all.
      </p>

      {error ? <p className="error">{String(error)}</p> : null}

      {/*
        Each section is a details block, and only the channel map starts open:
        it is the one thing anyone comes to this page to change. The rest is
        reference, and reference that is always expanded is just a long page.
      */}
      <details className="panel" open>
        <summary><span className="chevron" aria-hidden="true" />Slack channel to Space</summary>
      <p className="muted small">
        A task captured with <code>/task</code> lands in the Space its channel
        maps to. An unmapped channel goes to <strong>{view.defaultSpaceName}</strong>.
      </p>

      <div className="scroll-x">
        <table className="plain">
          <thead>
            <tr><th>Channel</th><th>ID</th><th>Space</th><th /></tr>
          </thead>
          <tbody>
            {view.channels.length === 0 ? (
              <tr><td colSpan={4} className="muted">No mappings yet.</td></tr>
            ) : view.channels.map((c) => (
              <tr key={c.channelId}>
                <td>{c.channelName ?? '—'}</td>
                <td><code>{c.channelId}</code></td>
                <td>{c.spaceName}</td>
                <td>
                  <form action={removeChannelMappingFormVoid}>
                    <input type="hidden" name="channelId" value={c.channelId} />
                    <button type="submit" className="link">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="fields" action={setChannelMappingFormVoid}>
        <label className="small">
          Channel ID
          <input type="text" name="channelId" required placeholder="C01ABCDEF" />
        </label>
        <label className="small">
          Channel name
          <input type="text" name="channelName" placeholder="#agency-ops" />
        </label>
        <label className="small">
          Space
          {/*
            The value is the canonical NAME, not the id: `setChannelMapping`
            resolves it with `findSpaceExact`. Sending ids here once made
            every mapping resolve to nothing and fall back to Inbox.
          */}
          <SpaceSelect
            name="spaceName"
            spaces={view.spaces}
            valueOf={(space) => space.name}
            defaultValue=""
            placeholder="Choose a Space"
            required
            ariaLabel="Space"
          />
        </label>
        <button type="submit" className="primary">Save mapping</button>
      </form>
      </details>

      <details className="panel">
        <summary><span className="chevron" aria-hidden="true" />Who can use this</summary>
      <p className="muted small">
        Set with <code>AUTHORIZED_SLACK_USER_IDS</code>. An empty list denies
        everyone, including in Slack.
      </p>
      <ul>
        {view.authorizedUserIds.length === 0 ? (
          <li className="error">
            Nobody is authorized. Set AUTHORIZED_SLACK_USER_IDS.
          </li>
        ) : view.authorizedUserIds.map((id) => (
          <li key={id}><code>{id}</code>{id === user.slackUserId ? ' (you)' : ''}</li>
        ))}
      </ul>
      </details>

      <details className="panel">
        <summary><span className="chevron" aria-hidden="true" />Imports</summary>
      {view.batches.length === 0 ? (
        <p className="muted small">
          No imports yet. Run <code>pnpm import-tasks</code>; see IMPORT.md.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="plain">
            <thead>
              <tr><th>When</th><th>Source</th><th>File</th><th>State</th><th>Rows</th></tr>
            </thead>
            <tbody>
              {view.batches.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td>{b.source_type}</td>
                  <td>{b.filename ?? '—'}</td>
                  <td>{b.state}</td>
                  <td>{b.row_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </details>

      <details className="panel">
        <summary><span className="chevron" aria-hidden="true" />Time zone</summary>
        <p className="muted small">
          Relative due dates like <code>due:tomorrow</code> resolve against{' '}
          <strong>{view.timeZone}</strong>.
        </p>
      </details>
    </Shell>
  );
}
