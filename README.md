# tg-bot3

Telegram front end for [Pi](https://github.com/earendil-works/pi). Each Telegram conversation (chat, or forum topic) gets its own `pi --mode rpc` process, started on demand in a working directory you choose with your normal Pi setup: settings, credentials, extensions, `AGENTS.md`. The bot keeps everything it owns in its state directory. The host adds its tools, a short runtime prompt, and the bot's own `AGENTS.md`.

There is no sandbox. Agents run as your user with your permissions; only users in `allowed.json` can wake them.

## Setup

Requires Node.js 24+ and `pi` on `PATH`.

```sh
pnpm install
mkdir -p -m700 ~/notes/bot
echo '{"token": "<BOT_TOKEN>", "cwd": "~"}' > ~/notes/bot/config.json
chmod 600 ~/notes/bot/config.json
echo '[<your chat id>]' > ~/notes/bot/allowed.json
node src/main.ts ~/notes/bot
```

If the state directory is in a Git repo, ignore `config.json`, `busy.json`, `host.sock`, `*.tmp`, and `sessions/` there.

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `token` | required | Bot token |
| `cwd` | required | Agent working directory |
| `agentDir` | Pi's default (`~/.pi/agent`) | Sets `PI_CODING_AGENT_DIR` for agents |
| `pi` | `pi` | Pi command |
| `lmk` | disabled | Optional [letmeknow bridge](#letmeknow-bridge) |

Paths are absolute; `~` expands to your home directory.

Agents load Pi's normal context files from the agent directory, the working directory, and its parents. The host also appends `AGENTS.md` from the state directory when present: put this bot's instructions there.

Run one process per bot, each with its own state directory. Bots may share an agent working directory. `deploy/tg-bot3@.service` is a systemd user template: `tg-bot3@notes` keeps its state in `~/notes/bot/`.

`allowed.json` lists user and chat IDs. Private chats of listed users are recorded. A listed group or channel is recorded in full only while a listed user is one of its admins (checked on every update); otherwise it is ignored. Records carry `meta.allowed_sender`, and only records from listed users can wake an agent. Other updates are dropped; the first per chat (or chatless sender) and process lifetime is recorded as `telegram.access_request` with IDs and username only, so an agent can add them when you approve.

## How it works

Files named below are in the state directory.

- **Timeline** (`timeline.jsonl`): every Telegram update, send, schedule change, steer, and annotation, one JSON record per line with a monotonic `seq`. Agents read it as shared memory. Incoming files go to `attachments/<chat>/<message>/`.
- **Waking**: from listed users, private messages, group messages that mention or reply to the bot, button presses, and group additions are delivered to the conversation's agent as the raw record.
- **Steering**: a user message arriving while the agent is busy is queued as a Pi steer; if the agent has not picked it up within two minutes, the host takes the queued messages back, aborts the run, and prompts with them. Scheduled prompts are queued as follow-ups.
- **Host tools** (`extensions/host-tools.ts`, loaded with `-e`): `send` (raw Bot API call into the agent's own conversation; local file paths upload), `annotate`, `steer_conversation`, and `schedule_add|replace|remove|take`. They reach the host over `host.sock`.
- **Schedules** (`schedules.json`): hourly, daily, weekly, or one-off; due schedules wake their owning conversation.
- **Lifecycle**: agents exit after one idle hour; `/restart` restarts all of them, killing any still busy after five seconds. A new process starts a fresh Pi session in `sessions/`, named `telegram <chat_id>:<thread_id>`. An agent stopped mid-run, by `/restart` or by the host stopping, is succeeded by a fresh one woken with an `agent_interrupted` record naming the stopped session; `busy.json` carries busy agents' sessions across host restarts. A failed run is reported in its chat as `Agent failed: …`.

## letmeknow bridge

To bridge a [letmeknow](https://letmeknow.dev) session into a chat with Telegram topics, add this to `config.json`:

```json
"lmk": { "session": "<session fingerprint>", "letmeknow": "npx -y @letmeknow/cli@0.26", "chat": -1001234567890, "user": 123456789 }
```

Add the chat and user to `allowed.json`. For a private chat, both IDs are the user's ID and the bot needs Threaded Mode enabled in BotFather. In a forum group, the bot needs permission to manage topics. Use a session in a trusted group: members can send raw Bot API calls through the bot.

- Incoming text and files go to the sender's fingerprint topic, created on demand. A `*.json` attachment is a Bot API request instead; it may specify `message_thread_id` (use `null` for no thread). The bridge fixes `chat_id` to the configured chat, does not upload host paths from JSON requests, and reserves polling and webhook management for the bot. Results go to the letmeknow log, with a file attached for `getFile`; errors come back as replies. Bot API calls also appear in `timeline.jsonl`.
- Only the configured user's updates in bridge-bound topics, or replies, button presses, reactions and poll answers tied to tracked bridge messages, go to letmeknow. They go to the relevant member as raw Telegram update JSON, with downloaded files attached. Unbound topics and other chats route to Pi as usual; there is no broadcast outside bridge topics.

The append-only `lmk-state.jsonl` stores message, poll and topic mappings. Keep it with the bot state. To cut over from `lmk-tg` **using the same Telegram bot and chat**, stop the old bridge before starting this one. Copy only the mappings from its `state.jsonl` to the new bot state directory (not its polling journal):

```sh
(umask 077; jq -c 'select(has("tg") or has("poll") or has("topic"))' /path/to/lmk-tg/state.jsonl > /path/to/tg-bot3/lmk-state.jsonl)
```

Do not run both bridges on the same bot or letmeknow session. The bridge does not replay unfinished deliveries after a restart.

## Checks

```sh
pnpm typecheck && pnpm test
```
