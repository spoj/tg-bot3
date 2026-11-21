# tg-bot3

Unified multi-chat Telegram gateway for [Pi](https://github.com/earendil-works/pi) over [letmeknow](https://letmeknow.dev) and `hc` (`herdr-core`).

Every Telegram conversation `(chat_id, message_thread_id)` maps 1:1 to a `letmeknow` member fingerprint. Independently launched Pis anywhere in your owner group talk through the same gateway as Pis spawned on demand via `hc` in your normal interactive Pi setup (`~/.pi/agent/sessions/`, attachable via `hc attach` / `hcm`, surviving bot restarts).

## Setup

Requires Node.js 24+, `pi` (with `pi-letmeknow`), `hc`, and `letmeknow` 0.26+.

`config.json` (in the state directory, mode `0600`):

```json
{
  "token": "<BOT_TOKEN>",
  "cwd": "~",
  "lmk": {
    "letmeknow": "npx -y @letmeknow/cli@0.26",
    "owner": {
      "session": "<owner bridge fp>",
      "group": "<owner group id>",
      "chat": 123456789,
      "user": 123456789
    },
    "local": {
      "session": "<local-only bridge fp>",
      "group": "<local-only group id>"
    }
  }
}
```

Optional keys: `agentDir`, `pi` (default `pi`), `hc` (default `hc`), `idleMs` (default `3600000`, 1h).

- **Isolation:** `lmk.owner` serves the owner's chat and all independent Pis in the owner group. `lmk.local` serves all other `allowed.json` chats (e.g. family/groups) in a separate machine-local `letmeknow` group so non-owner traffic never reaches other devices.
- **`allowed.json`:** array of allowed user and chat IDs. Private chats of listed users are admitted; listed groups/channels are admitted only while a listed user is an admin. Unlisted senders are logged once per process as `telegram.access_request`.

## Agent wire contract

Agents send to the bridge's `letmeknow` session fingerprint:

- **Plain text:** sent as `sendMessage` with `parse_mode: "HTML"`, retrying once as plain text on Telegram entity-parse errors. Silent on success.
- **File (`--attach /path/to/file`):** auto-selects `sendPhoto` (`.jpg/.png/.webp`), `sendVoice` (`.ogg/.opus`), `sendAudio`, `sendVideo`, or `sendDocument` (including `.json`), with `sendDocument` fallback. Text ≤ 1024 chars becomes the HTML caption. Silent on success.
- **Explicit Bot API call (`tg: { ... }`):** prefix message content with `tg: ` followed by a JSON object `{"method": "...", ...}`. Locked to the sender's bound `chat_id` (no cross-chat overrides); `message_thread_id` may target another topic or `null` within the bound chat without stealing that topic's reply binding. Use `"attach://file"` with `--attach` to upload a file in the same call (arbitrary host paths are never uploaded from JSON). Returns a correlated `{ request, result }` reply (and attached bytes for `getFile`).

## Lifecycle & host socket

- **Spawn / resume:** inbound messages (or `wake`) for an unbound or reaped conversation launch/resume `pi --session-id <uuid>` via `hc run --bg --no-parent --outlive-parent` with `PI_LETMEKNOW_JOIN`, `PI_LETMEKNOW_ATTACH=""`, and `PI_LETMEKNOW_READY_FILE`. State persists in `lmk-state.jsonl` (mode `0600`).
- **Idle reap:** bot-owned `hc` terminals (labeled `owner=tg-bot3`) idle for `idleMs` with status `idle`/`done`, no `hold` label, no active monitors, and no live `hc` children are killed and removed; the next message resumes the same Pi session history. Independently launched Pis are never reaped.
- **`/new`:** kills any bot-owned terminal for that conversation and unbinds it so the next message starts a fresh Pi session.
- **`host.sock` (mode `0600`):** minimal local Unix socket for scheduled jobs (`~/jobs/tg_notify.py`) exposing `send` (logs to `timeline.jsonl`, wakes no Pi; replies route to the topic's current binding) and `wake` (wakes/resumes the topic's Pi).

## Checks

```sh
pnpm typecheck && pnpm test
```
