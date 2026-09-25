# tg-bot3

Telegram front end for [Pi](https://github.com/earendil-works/pi). Each Telegram conversation (chat, or forum topic) gets its own `pi --mode rpc` process, started on demand in a working directory you choose with your normal Pi setup: settings, credentials, extensions, `AGENTS.md`. The bot keeps its state in `bot/` inside that directory. The host adds only its tools and a short runtime prompt.

There is no sandbox. Agents run as your user with your permissions; only chats in `bot/allowed.json` can reach them.

## Setup

Requires Node.js 24+ and `pi` on `PATH`.

```sh
pnpm install
mkdir -p -m700 ~/bothome/bot
echo '{"token": "<BOT_TOKEN>"}' > ~/bothome/bot/config.json
echo '[<your chat id>]' > ~/bothome/bot/allowed.json
printf 'bot/config.json\nbot/cursor\nbot/host.sock\nbot/sessions/\n' >> ~/bothome/.gitignore   # if it is a Git repo
node src/main.ts ~/bothome
```

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `token` | required | Bot token |
| `agentDir` | Pi's default (`~/.pi/agent`) | Sets `PI_CODING_AGENT_DIR` for agents |
| `pi` | `pi` | Pi command |

Run one process per bot, each with its own working directory. `deploy/tg-bot3@.service` is a systemd user template: `tg-bot3@bothome` runs in `~/bothome`.

Messages from chats that are not allowed are dropped; the first one per chat and process lifetime is recorded as `telegram.access_request`, so an agent can add the chat when you approve.

## How it works

- **Timeline** (`bot/timeline.jsonl`): every Telegram update, send, schedule change, steer, and annotation, one JSON record per line with a monotonic `seq`. Agents read it as shared memory. Incoming files go to `bot/attachments/<chat>/<message>/`.
- **Waking**: private messages, group messages that mention or reply to the bot, channel posts, button presses, and group additions are delivered to the conversation's agent as the raw record. `bot/notifications.json` overrides this per conversation: `{"<chat_id>:<thread_id>": {"wake": [types], "mute": [types]}}`. Deliveries are tracked by `bot/cursor`; undelivered records replay after a restart.
- **Steering**: a user message arriving while the agent is busy is queued as a Pi steer; if the agent has not picked it up within two minutes, the current operation is aborted so it does. Scheduled prompts are queued as follow-ups.
- **Host tools** (`extensions/host-tools.ts`, loaded with `-e`): `send` (raw Bot API call into the agent's own conversation; local file paths upload), `annotate`, `steer_conversation`, and `schedule_add|replace|remove|take`. They reach the host over `bot/host.sock`.
- **Schedules** (`bot/schedules.json`): hourly, daily, weekly, or one-off; due schedules wake their owning conversation.
- **Lifecycle**: agents exit after two idle hours; `/restart` restarts all of them once their current work settles. A new process starts a fresh Pi session in `bot/sessions/`, named `telegram <chat_id>:<thread_id>`.

## Checks

```sh
pnpm typecheck && pnpm test
```
