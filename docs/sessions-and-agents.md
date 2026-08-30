# Sessions and agents

**Status:** working end to end, verified 2026-08-29 (server, hooks, relay). The Android home page is built and compiles; it has not yet been installed on a handset.

What this adds: Tether knows what Claude Code sessions are running, which of them are stuck, what their subagents are doing, and can carry a message from the phone back into a live session.

---

## The constraint that shapes everything

**There is no supported third-party API for sending a message into a running Claude Code session.**

That is not a gap waiting to be filled by a better-chosen endpoint. It was checked against the CLI surface, the published docs, and the local state on this machine, and it is the single fact the whole design bends around. What actually exists:

| Capability | Surface | Status |
|---|---|---|
| Enumerate live sessions | `claude agents --json` → `pid, cwd, kind, sessionId, name` | **Public**, scriptable, needs no TTY |
| Rich session list (titles, groups, PR state) | `ccd_session_mgmt.list_sessions` | Callable only **from inside** a Claude session |
| Send into a live **local** session | `SendMessage`, `ccd_session_mgmt.send_message` | Callable only **from inside** a Claude session |
| Send into a **cloud** session | `claude -p --cloud <id> "msg"` | **Public and documented** — queues a follow-up |
| Send into a resumed session | `claude -p --resume <id>` | Public, but starts a **new process** over the transcript. Does not reach the running one |
| Remote Control | `claude remote-control` | **Proprietary.** Outbound HTTPS to Anthropic only, no inbound port; clients are claude.ai/code and the Claude apps. API keys explicitly unsupported. No webhook, no API |

Underneath, local peer messaging runs over a named pipe: `~/.claude/sessions/<pid>.json` carries a `messagingSocketPath`, and a sibling `.key` file holds `{peerToken, pidDomain, procStartFt}`. It is real, and it is on disk, and Tether deliberately does **not** use it — it is undocumented, so building on it means breaking on a Claude Code update with no warning and no error message worth reading.

**Custom initialization, by contrast, is fully supported and richer than expected.** Hooks fire on `SessionStart`, `SessionEnd`, `Stop` (carrying `last_assistant_message`), `Notification` (carrying `notification_type` / `notification_text`), `UserPromptSubmit`, and — the important one — `SubagentStart` / `SubagentStop`, which carry `agent_id` and `agent_type` alongside the parent's `session_id`. **The session/agent tree falls out of hooks alone, with no private APIs.**

So the architecture writes itself:

```
  a session                                            the phone
      │                                                    │
      │ hooks (public, stable, every machine)              │ client token
      ▼                                                    ▼
 ┌─────────────────────── Tether ───────────────────────────┐
 │  agent_sessions   ← who is running, and what they want    │
 │  session_messages ← one timeline, both directions         │
 └───────────────────────────────────────────────────────────┘
      ▲                                                    │
      │ SendMessage (only a Claude session can do this)     │ queued
      │                                                    ▼
   target  ◄────────────────  the relay  ◄─────────────  outbox
```

**Inbound is easy and supported. Outbound has to be done by something that is itself a Claude session.** Tether never pretends otherwise: it queues the message and records whether the relay managed it.

---

## Sessions are not agents

A **session** is something Mehdi started and can address — a Claude Code window, a terminal. An **agent** is a subagent some session spawned.

They share a table and a shape, and are told apart by `parent_id`. One rule falls out of that and is enforced on the server, not just in the UI:

> **A message is only ever addressed to a session.** A subagent has no inbox. Sending to one returns 409 with *"Subagents have no inbox. Send to the session that spawned it instead."*

The reason is presentational as much as technical. A session with four subagents running would otherwise look like five things needing attention on the home page, and four of the five taps would do nothing.

Subagents end when their parent ends — enforced in SQL (`endChildren`), because their transcript lives inside the parent's process and a "working" subagent whose parent is gone is a row that never goes away.

---

## States, and which one rings

| State | Means | Reaches out? |
|---|---|---|
| `working` | A prompt was submitted; it is running | no |
| `idle` | Finished its turn, would take input, not stuck | no |
| `waiting` | **Blocked on a human** | yes |
| `ended` | Gone | no |

Only `waiting` interrupts, and only **on the transition** — a hook that fires twice does not ring twice. A session going idle happens dozens of times an hour; alerting on it would make Tether the thing you mute.

Within `waiting`, the hook splits further. Claude Code sends two quite different things down the same `Notification` hook: *"I need permission to run this"* (the session is stopped) and *"you haven't typed in a while"* (it is not). `TETHER_RING=blocked`, the default, **calls** for the first and **notifies** for the second. `always` and `never` override it.

The alert is raised **out of band** — `void alert(...)`, not awaited. Rendering a call to speech takes longer than the hook's whole timeout budget, so awaiting it would mean the hook gives up and the human waits for work that completes either way. The state change is committed before the alert starts, which is the part that had to be durable.

---

## Wiring it up

### 1. The hooks (on every machine with sessions)

Merge `hooks/settings.example.json` into `~/.claude/settings.json`. Absolute paths — hooks do not run from the project directory.

```json
"env": {
  "TETHER_URL": "http://192.168.0.2:8790",
  "TETHER_AGENT_TOKEN": "<an agent token, NOT a client token>",
  "TETHER_RELAY": "vanta",
  "TETHER_RING": "blocked"
}
```

`TETHER_RELAY` is what makes a session addressable. **Leave it empty and the session registers honestly as unreachable** — visible on the home page, composer disabled, with the reason shown. That is deliberate: accepting text that nothing will collect is the worse failure.

Changes to `settings.json` are picked up by **already-running sessions**, verified 2026-08-29 — a live session started reporting its turns within one turn of the file being written. No restart needed.

The hook script follows four rules, in order:

1. **Never break the session.** Every failure path exits 0, silently.
2. **Never block.** Two seconds per request, capped, and the settings `timeout` is 6 to fit two of them.
3. **Say nothing on stdout.** Some hook events treat stdout as context to inject.
4. **Exit promptly and cleanly.** See the gotchas below — this one cost two rewrites.

### 2. The relay (one per machine)

A Claude session running the `tether-relay` skill. It polls, calls `SendMessage`, and reports back:

```bash
node X:/Projects/tether/relay/relay.mjs poll --wait 25   # blocks, prints work
node X:/Projects/tether/relay/relay.mjs ack <id>         # it landed
node X:/Projects/tether/relay/relay.mjs fail <id> "why"  # it did not
```

The split is because delivery is a *tool call*, which only a model can make; everything else is ordinary HTTP and belongs in a script. The relay's name must match what the sessions on that machine registered with, or its queue is empty forever and nothing says why.

### 3. Verify

```bash
BASE=http://192.168.0.2:8790 bash test-sessions.sh
```

31 checks: registration, state transitions, the session/agent distinction, queueing, relay isolation between machines, delivery, failure recording, the hook's failure modes, and token separation. Green against the NAS on 2026-08-29.

---

## The API

Agent token (hooks and relays):

| Route | Purpose |
|---|---|
| `POST /api/sessions/register` | Upsert. Idempotent — a resumed session is the same session |
| `POST /api/sessions/:id/state` | `working` / `idle` / `waiting` / `ended`, plus `ring` and `waitingOn` |
| `POST /api/sessions/:id/message` | Something the session said |
| `POST /api/sessions/:id/end` | Ends it, and its subagents |
| `GET /api/relay/:relay/outbox?wait=25` | Long-polled work queue, scoped to one relay |
| `POST /api/relay/messages/:id/settled` | `{ok: true}` or `{ok: false, error}` |

Client token (the phone, the web UI):

| Route | Purpose |
|---|---|
| `GET /api/sessions` | The home page: sessions with subagents nested, preview, pending count |
| `GET /api/sessions/:id` | One row |
| `GET /api/sessions/:id/messages` | The timeline |
| `POST /api/sessions/:id/messages` | Queue a message. **409 when nothing can carry it** |

`:id` accepts either Tether's id or the tool's own — hooks only know the latter, the app only knows the former, and making either translate would be pointless ceremony.

**Long-poll, not WebSocket**, for the outbox. A relay is a Claude session running a shell command: it can hold an HTTP request open inside one tool call, and it cannot hold a socket across them.

---

## Gotchas worth not rediscovering

- **`process.exit()` in the hook trips a libuv assertion on Windows.** Exiting while undici tears down its keep-alive socket gives `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, stderr noise and **exit 127, on every single turn**. The hook now uses `node:http` with `agent: false` and no explicit exit.
- **`AbortSignal.timeout` does not free the socket.** With `fetch`, an unreachable server left the process alive **13 seconds** on the OS TCP retry — the request aborts, the handle does not. `req.destroy()` is what actually ends it. Measured: 4.2s worst case now, 0.2s on connection refused, ~175ms normal.
- **Backticks inside a SQL comment close a TypeScript template literal.** `` -- `parent_id` is what separates them `` turned the schema string into a syntax error six lines later.
- **`/api/requests` without `?all=1` hides resolved requests**, which makes "did the alert fire?" look false when it fired and was collected.
- **The queue is scoped by relay name, joined in SQL.** One machine's relay must never be handed another machine's traffic because it polled first.
- **A message is queued, never optimistically shown as sent.** Delivery state is rendered only when it is *not* the boring case, because "waiting for the relay" and "delivered" are the difference between *it has my answer* and *it never got it*.
- UTF-8 round-trips intact through the server (verified by codepoint comparison). Mangling seen at a `curl` command line is Git Bash, not the wire.

---

## What is not done

- **The Android app has not been installed on the handset** — ADB showed no device on 2026-08-29. It compiles and the APK is built.
- **No relay runs automatically.** It has to be started as a session running the `tether-relay` skill; nothing supervises it. A message queued with no relay running sits until it expires after an hour.
- **`remote-control` transport is modelled but unused.** The registry accepts it; nothing registers with it yet. A NAS-hosted `claude remote-control` server would still need a relay session *inside* it, because Tether cannot reach Anthropic's transport from outside.
- Ordering is computed in the app rather than the server, so a future web UI would have to repeat it.
