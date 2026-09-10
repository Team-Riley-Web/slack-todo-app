# Slack Setup

## Why a new dedicated app

A separate Slack app rather than extending an existing Team Riley app:

1. **Socket Mode is an app-wide setting.** Enabling it on an app currently using
   HTTP changes how that app receives events and interactivity, and can break its
   existing request URLs.
2. **Slash commands are a per-app namespace.** Putting `/task` and `/tasks` on a
   shared app couples this deploy to that app's.
3. **New scopes force a reinstall** and re-approval of the existing app.
4. **Blast radius.** A crash here should not take down Hermes' Slack surface.

If you later want to consolidate, the things to check on the existing app are:
its current mode (Socket vs HTTP), whether `/task` or `/tasks` are already
claimed, and whether adding `commands` + `chat:write` triggers a workspace
admin approval you would rather not trigger.

## 1. Create the app

api.slack.com/apps → **Create New App** → From scratch. Name it (e.g. "Team Riley
Tasks") and pick the Team Riley workspace.

## 2. Bot token scopes

**OAuth & Permissions → Scopes → Bot Token Scopes:**

| Scope | Used for |
|---|---|
| `commands` | `/task` and `/tasks` |
| `chat:write` | posting task cards, `chat.update` in place, ephemeral replies |

That is the complete list. The app reads no messages, so it needs no
`channels:history`, no `channels:read`, and no user scopes. Channel → Space
mapping is configuration, not discovery.

## 3. Socket Mode

**Socket Mode → Enable Socket Mode.** Generate an app-level token with the
`connections:write` scope. That token is `SLACK_APP_TOKEN` (starts `xapp-`).

Socket Mode needs no public URL, which is why it is the local default.

## 4. Slash commands

**Slash Commands → Create New Command**, twice. Under Socket Mode the Request URL
field is not used.

| Command | Short description | Usage hint |
|---|---|---|
| `/task` | Capture a task, exactly as typed | `<task title> [due:YYYY-MM-DD]` |
| `/tasks` | View your tasks | `[space \| waiting]` |

## 5. Interactivity

**Interactivity & Shortcuts → toggle on.** Required for the checkbox and overflow
to send `block_actions`. Under Socket Mode no Request URL is needed.

The app listens for exactly two action IDs:

| `action_id` | Element | Meaning |
|---|---|---|
| `task_checkbox` | `checkboxes` | checked = complete, unchecked = reopen |
| `task_waiting` | `overflow` | Move to Waiting / Move to Open |

No events subscriptions are required. The app does not listen to messages.

## 6. Install and collect credentials

**Install App → Install to Workspace.** Then fill `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-…            # OAuth & Permissions
SLACK_APP_TOKEN=xapp-…            # Socket Mode app-level token
SLACK_SIGNING_SECRET=…            # Basic Information (needed for HTTP mode)
SLACK_TEAM_ID=T…                  # workspace ID — REQUIRED; blank rejects everything
DEFAULT_ASSIGNEE_SLACK_ID=U…      # Joshua's Slack user ID
DEFAULT_ASSIGNEE_LABEL=Joshua     # shown on cards; plain_text cannot render a mention
```

`SLACK_TEAM_ID` fails closed on purpose — leaving it blank rejects every
interaction rather than accepting any workspace.

To find your own user ID: Slack profile → **⋮** → Copy member ID.

## 7. Channel → Space mapping

Deterministic configuration. Invite the bot to each channel, then declare the
mapping in JSON and apply it:

```bash
cp config/channel-map.example.json config/channel-map.json
# fill in real channel IDs, then:
pnpm sync-channels          # --prune also deletes mappings absent from config
```

Channel IDs come from a channel's **View channel details → About**, at the
bottom. The sync validates every Space before writing anything, so a typo aborts
the whole run rather than importing a partial mapping. Re-running is idempotent.

`GET /channel-map` shows what is currently in effect.

An unmapped channel routes to **Inbox** and the card says so — it never guesses a
client from message text. Where a channel mapping resolves a client, message text
is never consulted.

The mapping also drives bare `/tasks` (which returns the channel's Space) and the
channel-aware Hermes tools, so it is worth getting right before rollout.

Suggested mapping:

| Channel | Space |
|---|---|
| `#agency-ops` | Agency / Internal |
| `#marketing` | Marketing |
| `#sales` | Sales |
| `#client-joy-within-birth` | Client - Joy Within Birth |
| `#client-secure-logic` | Client - Secure Logic |
| `#client-nazareth-law` | Client - Nazareth Law |
| `#client-milltown-cabinets` | Client - Milltown Cabinets |
| `#client-cfc-skincare` | Client - CFC Skincare |
| `#client-yoga-farm` | Client - Yoga Farm |

## 8. Run it

```bash
pnpm migrate
pnpm slack
```

Expect `[slack] running in socket mode`. An `invalid_auth` error means the bot
token is wrong or the app is not installed.

## 9. The one runtime verification

Everything else is covered by 158 automated tests. This single behaviour is
specified in Slack's own type definitions but only provable against a live
workspace:

1. In a mapped channel, run `/task Test the checkbox`.
2. Confirm the card renders `[ ] Test the checkbox` with a **native** checkbox on
   the left and a smaller meta line beneath.
3. **Click the checkbox.**
4. Confirm — in the same message, with no second message posted — that:
   - the box is now **checked**, and
   - the title renders **struck through**, and
   - the meta line reads `Completed <date> · <Space>`.
5. **Click the checkbox again.** Confirm the task returns to unchecked with no
   strikethrough.

Step 4's strikethrough is the item to watch. `@slack/types` documents
`option.text` as accepting `MrkdwnElement` "to be used with radio buttons and
checkboxes," so it should render. If it does not, the fix is localized to
`taskOption` in `packages/slack-ui/src/card.ts` — and note that completion is
still unambiguous from the checked box plus the `Completed <date>` meta line,
which is deliberately independent of strikethrough.

If the box appears **unchecked on a completed task**, that is the
`initial_options` mismatch described in `ARCHITECTURE.md`; check that
`taskOption` is not being called twice for the same task.

## HTTP mode (deployment)

Set `SLACK_MODE=http` and `PORT`. Then set the Request URL on both Slash Commands
and Interactivity to `https://<host>/slack/events`, and disable Socket Mode.
Request signatures are verified with the v0 HMAC scheme and a five-minute replay
window.
