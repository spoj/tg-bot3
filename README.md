# tg-bot3

Telegram front end for [Pi](https://github.com/earendil-works/pi). Each Telegram conversation (chat, or forum topic) gets its own `pi --mode rpc` process, started on demand in a working directory you choose with your normal Pi setup: settings, credentials, extensions, `AGENTS.md`. The bot keeps its state in `bot/` inside a separate bot home directory. The host adds its tools, a short runtime prompt, and any instruction files configured for this bot.

There is no sandbox. Agents run as your user with your permissions; only users in `bot/allowed.json` can wake them.

## Setup

Requires Node.js 24+ and `pi` on `PATH`.

```sh
pnpm install
mkdir -p -m700 ~/bothome/bot
echo '{"token": "<BOT_TOKEN>", "cwd": "~"}' > ~/bothome/bot/config.json
chmod 600 ~/bothome/bot/config.json
echo '[<your chat id>]' > ~/bothome/bot/allowed.json
printf 'bot/config.json\nbot/cursor\nbot/host.sock\nbot/sessions/\n' >> ~/bothome/.gitignore   # if it is a Git repo
node src/main.ts ~/bothome
```

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `token` | required | Bot token |
| `cwd` | required | Agent working directory, independent of bot state |
| `instructions` | `[]` | Instruction files appended with `--append-system-prompt` |
| `agentDir` | Pi's default (`~/.pi/agent`) | Sets `PI_CODING_AGENT_DIR` for agents |
| `pi` | `pi` | Pi command |

`cwd`, `instructions`, and `agentDir` paths resolve relative to the bot home directory; absolute paths and `~` are supported. Pi still loads its normal context files from the agent directory, the working directory, and its parents. Configured instruction files load in addition to those; do not list files that Pi already discovers. For example, create `~/bothome/AGENTS.md` for shared rules and `~/bothome/bot/AGENTS.md` for Telegram-only rules, then set `"instructions": ["AGENTS.md", "bot/AGENTS.md"]`.

Run one process per bot, each with its own bot home directory. Bots may share an agent working directory. `deploy/tg-bot3@.service` is a systemd user template: `tg-bot3@bothome` reads `~/bothome/bot/config.json` and keeps state in `~/bothome/bot/`; agents run in its configured `cwd`.

`allowed.json` lists user and chat IDs. Private chats of listed users are recorded. A listed group or channel is recorded in full only while a listed user is one of its admins (checked on every update); otherwise it is ignored. Records carry `meta.allowed_sender`, and only records from listed users can wake an agent. Other updates are dropped; the first per chat (or chatless sender) and process lifetime is recorded as `telegram.access_request` with IDs and username only, so an agent can add them when you approve.

## How it works

- **Timeline** (`bot/timeline.jsonl`): every Telegram update, send, schedule change, steer, and annotation, one JSON record per line with a monotonic `seq`. Agents read it as shared memory. Incoming files go to `bot/attachments/<chat>/<message>/`.
- **Waking**: from listed users, private messages, group messages that mention or reply to the bot, button presses, and group additions are delivered to the conversation's agent as the raw record. `bot/notifications.json` overrides this per conversation, still only for listed users: `{"<chat_id>:<thread_id>": {"wake": [types], "mute": [types]}}`. Deliveries are tracked by `bot/cursor`; undelivered records replay after a restart.
- **Steering**: a user message arriving while the agent is busy is queued as a Pi steer; if the agent has not picked it up within two minutes, the current operation is aborted so it does. Scheduled prompts are queued as follow-ups.
- **Host tools** (`extensions/host-tools.ts`, loaded with `-e`): `send` (raw Bot API call into the agent's own conversation; local file paths upload), `annotate`, `steer_conversation`, and `schedule_add|replace|remove|take`. They reach the host over `bot/host.sock`.
- **Schedules** (`bot/schedules.json`): hourly, daily, weekly, or one-off; due schedules wake their owning conversation.
- **Lifecycle**: agents exit after two idle hours; `/restart` restarts all of them once their current work settles. A new process starts a fresh Pi session in `bot/sessions/`, named `telegram <chat_id>:<thread_id>`.

## Checks

```sh
pnpm typecheck && pnpm test
```
