# tg-bot3

Telegram front end for [Pi](https://github.com/earendil-works/pi). Each Telegram conversation (chat, or forum topic) gets its own `pi --mode rpc` process, started on demand in a directory you choose with your normal Pi setup: settings, credentials, extensions, `AGENTS.md`. The host adds only its tools and a short runtime prompt.

There is no sandbox. Agents run as your user with your permissions; only chats in `allowed.json` can reach them.

## Setup

Requires Node.js 24+ and `pi` on `PATH`.

```sh
pnpm install
mkdir -p -m700 ~/.local/share/tg-bot3/mybot
echo '{"token": "<BOT_TOKEN>", "cwd": "~"}' > ~/.local/share/tg-bot3/mybot/config.json
echo '[<your chat id>]' > ~/.local/share/tg-bot3/mybot/allowed.json
node src/main.ts ~/.local/share/tg-bot3/mybot
```

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `token` | required | Bot token |
| `cwd` | `~` | Working directory of every agent, e.g. `~` or `~/bothome` |
| `agentDir` | Pi's default (`~/.pi/agent`) | Sets `PI_CODING_AGENT_DIR` for agents |
| `pi` | `pi` | Pi command |

Run one process per bot, each with its own state directory. `deploy/tg-bot3@.service` is a systemd user template: `tg-bot3@mybot` uses `~/.local/share/tg-bot3/mybot`.

Messages from chats that are not allowed are dropped; the first one per chat and process lifetime is recorded as `telegram.access_request`, so an agent can add the chat when you approve.

## How it works

- **Timeline** (`timeline.jsonl`): every Telegram update, send, schedule change, steer, and annotation, one JSON record per line with a monotonic `seq`. Agents read it as shared memory. Incoming files go to `attachments/<chat>/<message>/`.
- **Waking**: private messages, group messages that mention or reply to the bot, channel posts, button presses, and group additions are delivered to the conversation's agent as the raw record. `notifications.json` overrides this per conversation: `{"<chat_id>:<thread_id>": {"wake": [types], "mute": [types]}}`. Deliveries are tracked by `cursor`; undelivered records replay after a restart.
- **Steering**: a user message arriving while the agent is busy is queued as a Pi steer; if the agent has not picked it up within two minutes, the current operation is aborted so it does. Scheduled prompts are queued as follow-ups.
- **Host tools** (`extensions/host-tools.ts`, loaded with `-e`): `send` (raw Bot API call into the agent's own conversation; local file paths upload), `annotate`, `steer_conversation`, and `schedule_add|replace|remove|take`. They reach the host over `host.sock`.
- **Schedules** (`schedules.json`): hourly, daily, weekly, or one-off; due schedules wake their owning conversation.
- **Lifecycle**: agents exit after two idle hours; `/restart` restarts all of them once their current work settles. A new process starts a fresh Pi session, named `telegram <chat_id>:<thread_id>` in the session list.

## Checks

```sh
pnpm typecheck && pnpm test
```
