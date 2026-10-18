# Agent to agent

Tether began as *agent → human*: an agent that needs a decision parks in `ask`
until a phone answers. This document is about the generalisation — *agent →
agent* — and about why it turned out to be a small change rather than a new
subsystem.

## The insight

`ask` never cared **who** answered. It cared that the question was durable, that
the asker could park without spinning, and that somebody eventually settled it.
The audience was hardcoded to "the human" only because that was the only
audience there was.

So the change is one field. A request now carries `to_peer`, and an empty
`to_peer` means the human — which every request predating this feature was, so
no data had to move. Everything else the state machine already did (expiry,
recoverable request ids, long-poll, `collect`, `cancel`, the guarded UPDATE that
makes two answerers produce exactly one winner) applies unchanged to two agents
talking to each other.

## Why no relay is needed

The instinct is that agent-to-agent needs a message bus that can *push into* a
running session. It does not, and that matters, because pushing into a running
session is the one thing that genuinely cannot be done: neither Claude Code nor
Codex exposes a third-party API for injecting a message, and Claude Code's local
peer channel is a named pipe keyed to a PID **on one machine** — a session on the
NAS cannot poke a session on the PC.

But both agents are MCP *clients*. Both call outward. If both call outward to the
same server, that server is a rendezvous:

```
claude-code                    tether                     astra
     |                            |                          |
     |-- peer_ask("astra", Q) --->|                          |
     |        (blocks)            |<---- inbox_wait() -------|
     |                            |          (blocks)        |
     |                            |------- Q --------------->|
     |                            |<------ reply(A) ---------|
     |<--------- A ---------------|                          |
```

Neither agent has to be reachable. Neither has to be running when the other
speaks — the question sits in SQLite in between. The human is a participant in
the same graph rather than a router between two halves of it.

## Identity comes from the token

Before this, the caller's name came from an `X-Agent-Name` header. That was fine
while the only audience was a human reading a notification: a wrong label is a
cosmetic bug.

It stops being fine the moment agents can address each other. A name any client
can set is a name any client can forge, and forging a name is how you read
someone else's inbox. So the token decides now. `peers.authenticate()` maps a
bearer token to a peer row; the header survives only as a display hint for legacy
`AGENT_TOKENS` entries that map to no peer.

**Give every agent its own token.** Two agents sharing one token share one
identity, which means they cannot address each other at all — and it means
either can read the other's inbox. This was a real bug in the repo when the
feature was designed: `.codex/config.toml` held Claude's token and
`X-Agent-Name: claude-code`, so Codex was authenticating *as* Claude.

## Nothing authenticates as the human

The human peer holds **no token**. This is the security boundary of the whole
feature, and it is worth being explicit about why.

A request addressed to a human is answerable only over the client surface — the
phone and the web UI, which authenticate with client tokens and per-device
tokens. `requests.resolve()` takes an `as` argument and refuses any mismatch, so
the check cannot be forgotten at a call site. An agent calling `reply` on a
human-addressed request is told it was not addressed to it.

Without that, one prompt-injected agent could answer its own approval request,
and the human-in-the-loop guarantee Tether exists to provide would be
decorative. The same rule runs the other way: the phone cannot answer a question
one agent asked another, because the asking agent would attribute a human's
words to a peer.

## Read cursors are a day-one requirement

`peer_cursors` holds a per-peer rowid watermark. This is not an optimisation.

Without it, `inbox_wait` returns everything currently pending, every time. An
agent woken by a doorbell would re-read and re-answer the same message on every
turn, forever. The cursor is a **rowid**, not a `created_at`, because rowids are
monotonic per insert and two requests can land in the same millisecond. The
advance is guarded with `MAX(...)` so a replayed or out-of-order advance can
never rewind and re-deliver work already handled.

## Agent traffic never rings

Two guards, both one line, both in `requests.isForHuman()`:

- `channels.startFanout()` skips non-human requests — no push, no ntfy, no
  Telegram. An agent asking another agent a question is work, not a
  notification; fanning it out would make Tether ring all day.
- The WebSocket request feed skips them too, and `listPending`/`listRecent` are
  scoped to `to_peer = ''`. The home page is the human's view of their own
  queue, and showing them a question that is not theirs invites them to answer it.

## The tools

| Tool | Blocks? | For |
|---|---|---|
| `peer_list` | no | Who is addressable. Call it before guessing a name. |
| `peer_send` | no | Handoffs and status: "I pushed the branch". |
| `peer_ask` | **yes** | A question you cannot continue without. |
| `inbox_wait` | **yes** | Park until somebody addresses you. |
| `reply` | no | Answer a question `inbox_wait` handed you. |

`peer_ask` returns a request id, so an interrupted call picks the answer up with
`collect` — the same recovery path `ask` has always had.

## Registering a peer

There is deliberately **no HTTP route that mints a peer token**. An endpoint that
hands out identities hands them out to whoever finds it — and this server is
meant to end up behind a public hostname. Tokens come from the CLI, on the same
argument as `pair`: anyone who can run a process next to the database is already
more privileged than any token it could issue.

```bash
docker exec -it tether node src/cli/peer.ts add claude-code --tool claude-code
docker exec -it tether node src/cli/peer.ts add astra --tool codex
docker exec -it tether node src/cli/peer.ts add mehdi --human
docker exec -it tether node src/cli/peer.ts list
docker exec -it tether node src/cli/peer.ts revoke astra
```

The token prints once and is not recoverable. To rotate, revoke and add again.

## The doorbell, and what is still open

`inbox_wait` is the floor, not the ceiling. It works when an agent chooses to
park — which is the common case at the end of a turn — but it does nothing for
an agent that is mid-task or not running. Ranked, best first:

1. **Park when idle (`inbox_wait`)** — implemented. Free, no polling, no extra
   process. Requires the agent to decide to park.
2. **Hooks as a doorbell** — a `Stop` hook checks the inbox and injects context
   if something is waiting. Free when idle, and both platforms now support it
   (Codex promoted hooks to stable). This is the next thing to build.
3. **A courier session per platform** — already exists for Claude as
   `relay/relay.mjs` + `skills/tether-relay`. Works, but costs tokens
   continuously because something must stay awake.
4. **Spawning `codex exec` / `claude -p`** — the only way to wake an agent that
   is not running at all. Must run on the machine the agent lives on; a session
   spawned on the NAS cannot reach the PC.

Also open:

- **`peer_send` has no delivery receipt.** The sender learns nothing about
  whether it was read. The cursor knows; it is simply not exposed yet.
- **No conversation threading.** Each `peer_ask` is a fresh request. A
  back-and-forth is N unrelated rows, and neither side can see the thread.
- **The human cannot yet watch agent-to-agent traffic.** It is deliberately
  hidden from the pending list, but there should be a read-only view of it —
  being able to see what two agents agreed while you were out is most of the
  value of them agreeing it through your server.
