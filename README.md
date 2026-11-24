# tg-bot3

Unified multi-chat Telegram gateway for coding agents (`agy`, `pi`, `codex`, `claude`, plus custom presets) over [letmeknow](https://letmeknow.dev), `hc` (`herdr-core`), and `hc-lmk` / `lmk`.

Every Telegram conversation `(chat_id, message_thread_id)` maps 1:1 to a `letmeknow` member fingerprint. Independently launched agents anywhere in your owner group talk through the same gateway as agent sessions spawned on demand via `hc-lmk` (attachable via `hc attach` / `hcm`, surviving bot restarts).

## Setup

Requires Node.js 24+, `hc`, `hc-lmk` + `lmk`, `letmeknow` 0.26+, and whichever agent harness(es) you use (`agy`, `pi`, `codex`, `claude`).

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

Optional keys:
- `harness`: default harness preset for newly spawned topics (`"agy"` by default; built-ins: `"agy"`, `"pi"`, `"codex"`, `"claude"`).
- `harnesses`: per-harness overrides or custom aliases `Record<string, { bin?: string; args?: string[]; preset?: string }>` (legacy `agy` binary override is also still accepted).
- `hc` (default `"hc"`), `hcLmk` (default `"hc-lmk"`).
- `deliver`: `hc-lmk` delivery mode (`"always"` default, or `"idle"`).
- `idleMs` (default `3600000`, 1h).

- **Isolation:** `lmk.owner` serves the owner's chat and all independent agents in the owner group. `lmk.local` serves all other `allowed.json` chats (e.g. family/groups) in a separate machine-local `letmeknow` group so non-owner traffic never reaches other devices.
- **`allowed.json`:** array of allowed user and chat IDs. Private chats of listed users are admitted; listed groups/channels are admitted only while a listed user is an admin. Unlisted senders are logged once per process as `telegram.access_request`.

## Agent wire contract

Agents send to the bridge's `letmeknow` session fingerprint using `lmk`:

- **Plain text:** sent as `sendMessage` with `parse_mode: "HTML"`, HTML-safely chunked at 4096 chars, retrying once as plain text on Telegram entity-parse errors. Silent on success.
- **File (`--attach /path/to/file`):** auto-selects `sendPhoto` (`.jpg/.png/.webp`), `sendVoice` (`.ogg/.oga/.opus`), `sendAudio`, `sendVideo`, or `sendDocument` (including `.json`), with `sendDocument` fallback. Text ≤ 1024 chars becomes the HTML caption. Silent on success.
- **Explicit Bot API call (`tg: { ... }`):** prefix message content with `tg: ` followed by a JSON object `{"method": "...", ...}`. Locked to the sender's bound `chat_id` (no cross-chat overrides); `message_thread_id` may target another topic or `null` within the bound chat without stealing that topic's reply binding. Use `"attach://file"` with `--attach` to upload a file in the same call (arbitrary host paths are never uploaded from JSON). Returns a correlated `{ request, result }` reply (and attached bytes for `getFile`).

## Lifecycle & host socket

- **Spawn / resume:** inbound messages (or `wake`) for an unbound or reaped conversation launch the conversation's harness via `hc-lmk --bg --json --no-parent --outlive-parent --no-notify --join <group> --attach "" --ready-file <f> [--session <saved_fp>] [--deliver <mode>] -- <harness argv...>`. Per-conversation prompt files persist at `<stateDir>/prompts/<conv>.md` (mode `0600`) so concurrent harness boot never races with `readyFile` cleanup. State persists in `lmk-state.jsonl` (mode `0600`), storing `{ harness, resumeId, fp }` and remaining backward-compatible with legacy `conversationId` (`agy`) and `sessionId` (`pi`) entries.
- **Idle reap:** bot-owned `hc` terminals (labeled `owner=tg-bot3`) idle for `idleMs` with status `idle`/`done`, no `hold` label, no active monitors, and no live `hc` children are killed and removed (after best-effort `resumeId` discovery for `agy`/`codex`); the next message resumes the same harness, conversation `resumeId`, and `letmeknow` `--session <fp>`. Independently launched agents are never reaped.
- **Typing indicator:** for bot-owned `hc` terminals, inbound deliveries check `hc get` and send `sendChatAction("typing")` every 4.5s only while `status.state === "working"`. Remote/unowned sessions emit no typing indicator.
- **`/new [harness]`:** kills any bot-owned terminal for that conversation and unbinds it. `/new` resets back to the default harness; `/new pi`, `/new codex`, `/new agy`, `/new claude` (or any configured custom harness) pins the next launch of that conversation to the requested harness (persisted across restarts).
- **`host.sock` (mode `0600`):** minimal local Unix socket for scheduled jobs (`~/jobs/tg_notify.py`) exposing `send` (logs to `timeline.jsonl`, wakes no session; replies route to the topic's current binding) and `wake` (wakes/resumes the topic's session).

## Checks

```sh
pnpm typecheck && pnpm test
```
