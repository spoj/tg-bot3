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

If the state directory is in a Git repo, ignore `config.json`, `cursor`, `host.sock`, and `sessions/` there.

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `token` | required | Bot token |
| `cwd` | required | Agent working directory |
| `agentDir` | Pi's default (`~/.pi/agent`) | Sets `PI_CODING_AGENT_DIR` for agents |
| `pi` | `pi` | Pi command |

Paths are absolute; `~` expands to your home directory.

Agents load Pi's normal context files from the agent directory, the working directory, and its parents. The host also appends `AGENTS.md` from the state directory when present: put this bot's instructions there.

Run one process per bot, each with its own state directory. Bots may share an agent working directory. `deploy/tg-bot3@.service` is a systemd user template: `tg-bot3@notes` keeps its state in `~/notes/bot/`.

`allowed.json` lists user and chat IDs. Private chats of listed users are recorded. A listed group or channel is recorded in full only while a listed user is one of its admins (checked on every update); otherwise it is ignored. Records carry `meta.allowed_sender`, and only records from listed users can wake an agent. Other updates are dropped; the first per chat (or chatless sender) and process lifetime is recorded as `telegram.access_request` with IDs and username only, so an agent can add them when you approve.

## How it works

Files named below are in the state directory.

- **Timeline** (`timeline.jsonl`): every Telegram update, send, schedule change, steer, and annotation, one JSON record per line with a monotonic `seq`. Agents read it as shared memory. Incoming files go to `attachments/<chat>/<message>/`.
- **Waking**: from listed users, private messages, group messages that mention or reply to the bot, button presses, and group additions are delivered to the conversation's agent as the raw record. `notifications.json` overrides this per conversation, still only for listed users: `{"<chat_id>:<thread_id>": {"wake": [types], "mute": [types]}}`. Deliveries are tracked by `cursor`; undelivered records replay after a restart.
- **Steering**: a user message arriving while the agent is busy is queued as a Pi steer; if the agent has not picked it up within two minutes, the current operation is aborted so it does. Scheduled prompts are queued as follow-ups.
- **Host tools** (`extensions/host-tools.ts`, loaded with `-e`): `send` (raw Bot API call into the agent's own conversation; local file paths upload), `annotate`, `steer_conversation`, and `schedule_add|replace|remove|take`. They reach the host over `host.sock`.
- **Schedules** (`schedules.json`): hourly, daily, weekly, or one-off; due schedules wake their owning conversation.
- **Lifecycle**: agents exit after two idle hours; `/restart` restarts all of them once their current work settles. A new process starts a fresh Pi session in `sessions/`, named `telegram <chat_id>:<thread_id>`.

## Checks

```sh
pnpm typecheck && pnpm test
```
