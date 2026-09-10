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

**Fast route.** api.slack.com/apps → **Create New App** → **From an app
manifest** → pick the Team Riley workspace → paste
`config/slack-app-manifest.yaml`. That sets the scopes, Socket Mode,
interactivity and all three slash commands at once, so **sections 2, 4 and 5
below are already done** — read them for the reasoning, skip the clicking.

The manifest cannot install itself, so continue at section 3 (Socket Mode
token) and section 6 (install and collect credentials).

**Manual route.** Create New App → From scratch. Name it (e.g. "Team Riley
Tasks") and pick the Team Riley workspace, then work through every section
below.

## 2. Bot token scopes

**OAuth & Permissions → Scopes → Bot Token Scopes:**

| Scope | Used for |
|---|---|
| `commands` | `/task`, `/tasks`, `/import` |
| `chat:write` | posting task cards, `chat.update` in place, ephemeral replies |
| `files:read` | reading the file uploaded to the import wizard |

That is the complete list. The app reads no messages, so it needs no
`channels:history`, no `channels:read`, and no user scopes. Channel → Space
mapping is configuration, not discovery.

`files:read` exists solely so the import wizard can fetch the bytes behind an
uploaded file: `url_private` is not a public URL and requires an Authorization
header carrying a token with that scope. It is the one scope the wizard adds,
and it is why adding the wizard forces a reinstall (see the warning at the top
of this document).

## 3. Socket Mode

**Socket Mode → Enable Socket Mode.** Generate an app-level token with the
`connections:write` scope. That token is `SLACK_APP_TOKEN` (starts `xapp-`).

Socket Mode needs no public URL, which is why it is the local default.

## 4. Slash commands

**Slash Commands → Create New Command**, three times. Under Socket Mode the
Request URL field is not used.

| Command | Short description | Usage hint |
|---|---|---|
| `/task` | Capture a task, exactly as typed. No text opens a form. | `<task title> [due:YYYY-MM-DD]` |
| `/tasks` | View your tasks | `[space \| waiting]` |
| `/import` | Import tasks from a CSV or JSON file | (no arguments) |

Leave **Escape channels, users, and links** OFF on `/task`. With it on, Slack
rewrites references before the text reaches the app — `@joshua` becomes
`<@U01ABCDEF>`, `#sales` becomes `<#C0123|sales>` — which would silently
corrupt the byte-exact title this whole system is built to guarantee. The
manifest sets `should_escape: false` for exactly this reason.

## 5. Interactivity and shortcuts

**Interactivity & Shortcuts → toggle on.** Required for the checkbox to send
`block_actions` and for the modals to send `view_submission`. Under Socket Mode
no Request URL is needed.

The card itself carries nothing but the checkbox. Task actions live in Slack's
own **More actions** (⋮) menu on the message, alongside Reply in thread,
Forward and Save for later — they are **message shortcuts**, which the manifest
already declares:

| Shortcut | `callback_id` | What it does |
|---|---|---|
| Edit task | `task_edit_shortcut` | Opens the full edit form |
| Toggle Waiting | `task_waiting_shortcut` | Waiting ⇄ open |

A message shortcut targets the **message**, not a task. A card posted by
`/tasks` holds many tasks, so when there is more than one the app opens a
picker first and asks which. It never acts on the first one by default.

"Toggle Waiting" is named for what it does. One static menu label has to serve
a task in either state, and a label that lies is worse than a slightly
technical one. A completed task is not moved at all — unticking the checkbox is
the reopen gesture, and this must not become a second way to change completion.

The app listens for these action IDs:

| `action_id` | Element | Meaning |
|---|---|---|
| `task_checkbox` | `checkboxes` | checked = complete, unchecked = reopen |
| `task_waiting` | `overflow` | kept only for cards posted before the shortcuts landed |

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

**In Slack:** run `/tasks map` in the channel. A modal lists every Space, with
the current one preselected; picking "none" unmaps the channel and sends its
tasks to Inbox. Nothing to type, no Space name to get wrong.

**In bulk:** for a first rollout across many channels, the JSON file is still
faster. Invite the bot to each channel, then declare the mapping and apply it:

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

**One instance only.** Socket Mode lets several processes connect to the same
app, and Slack delivers each event to exactly one of them — so a forgotten
instance does not fail, it quietly serves a share of the traffic with whatever
code it started with. The app takes a pidfile lock (`.slack.pid`) and refuses
to start when another instance holds it, naming the pid to kill.

Note that `pkill -f "tsx apps/slack/src/index.ts"` kills the tsx child but
leaves the `pnpm slack` parent, which is how three instances once ended up
running at once. Use `pkill -f "pnpm slack"` as well, or just Ctrl-C.

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
