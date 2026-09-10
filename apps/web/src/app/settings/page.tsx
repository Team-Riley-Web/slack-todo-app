import { getDb } from '@/db';
import { requireUser } from '@/user';
import { settingsView } from '@/operations/settings';
import {
  setChannelMappingFormVoid, removeChannelMappingFormVoid,
} from '@/actions/settings';
import { Shell } from '@/components/Shell';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { error } = await searchParams;
  const view = await settingsView(await getDb());

  return (
    <Shell current="/settings" who={user.name ?? user.slackUserId}>
      <h1>Settings</h1>
      <p className="muted small">
        No tokens or keys are shown here, or read by this page at all.
      </p>
      {error ? <p className="error">{String(error)}</p> : null}

      <h2>Slack channel to Space</h2>
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

      <form className="inline" action={setChannelMappingFormVoid}>
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
          <select name="spaceName" required defaultValue="">
            <option value="" disabled>Choose a Space</option>
            {view.spaces.map((s) => (
              <option key={s.id} value={s.name}>{s.name}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">Save mapping</button>
      </form>

      <h2>Who can use this</h2>
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

      <h2>Imports</h2>
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

      <h2>Time zone</h2>
      <p className="muted small">
        Relative due dates like <code>due:tomorrow</code> resolve against{' '}
        <strong>{view.timeZone}</strong>.
      </p>
    </Shell>
  );
}
