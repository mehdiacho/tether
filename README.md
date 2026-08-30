# Tether

**A human-in-the-loop layer for AI agents.** The channel an agent uses to reach you, ask a question,
and *wait for the answer*.

Self-hosted. One container, one SQLite file, an MCP endpoint, and whatever notification channels you
want to fan out to.

---

## Why

Notification tools are fire-and-forget. That's the wrong shape for an agent.

When an agent gets stuck it doesn't need a notification — it needs **a question with a pending answer**.
*I need you to log in. Approve this deploy? What's the OTP?* The agent is blocked, and the interaction
has state: pending → answered → resumed, or pending → timed out → abandoned.

So the primitive here is `ask()`, not `notify()`. Notification is the degenerate case of a question
nobody has to answer.

The alternative today is that the agent gives up and you find out later.

## Status

**Stages 1–3 working, plus calls and schedules.** Server, MCP endpoint, blocking `ask`, durable pending
state, web UI, voice calls with kept recordings, recurring schedules that fire with no agent running,
and an **Android app** that rings like a phone call — full-screen incoming-call screen, answer from the
lock screen, and the agent's voice on pickup.

The app builds and installs; it is not on Play yet. See [android/](android/).

---

## Quick start

```bash
npm install
cp .env.example .env      # then generate real tokens (see below)
npm start
```

Generate tokens:

```bash
openssl rand -hex 24
```

Put one in `AGENT_TOKENS`, a different one in `CLIENT_TOKENS`. **Keep the two sets disjoint** — an agent
must not be able to answer its own question, or the human-in-the-loop guarantee is decorative. The server
refuses to start if they overlap.

Then pair a phone — this needs no token and prints a QR straight into the terminal:

```bash
npm run pair
```

### Point Claude Code at it

```bash
claude mcp add --transport http tether http://localhost:8790/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```

Or drop a `.mcp.json` in your project (this repo has one, gitignored because it holds a live token).

### Verify

```bash
./test-flow.sh
```

Covers the behaviour that actually matters: `ask` blocks, a client answer resumes it, a resolved answer
is recoverable after a crash, a second answer loses the race, and refusal reads differently from timeout.

---

## Tools the agent sees

| Tool | Blocks | What it's for |
|---|---|---|
| `notify` | no | Job finished, build failed. Optional voice rendering. |
| `ask` | **yes** | A decision. Optional choices become tappable buttons. |
| `request_action` | **yes** | "Sign in / approve this" — things the agent cannot do itself. |
| `collect` | **yes** | Pick up an answer after a crash or interrupted tool call. |
| `cancel` | no | Withdraw a request that no longer matters. |
| `speak` | no | Voice message in your chosen voice. Only registered when Fish Audio is configured. |
| `call` | only if you ask it to | Speaks at **max priority**, breaks through Do Not Disturb, and keeps the recording for replay. |
| `schedule_create` | no | A recurring job Tether fires itself — no agent has to be running. |
| `schedule_list` / `schedule_delete` | no | Inspect and remove schedules. |

See [docs/calls-and-schedules.md](docs/calls-and-schedules.md) for what a "call" actually is, why every
voice message gets 700ms of silence prepended, and the `[bracket]` delivery markers.

Every tool returns a **request id**. An interrupted `ask` is recoverable, not lost — that's what makes
this safe to depend on for long unattended runs.

### The status contract

`ask` returns one of `ANSWERED` / `REFUSED` / `TIMED_OUT` / `CANCELLED`, and the tool descriptions tell
the agent to treat them differently. **A timeout is not consent.** An agent that can't distinguish "you
said no" from "you never saw it" will do the wrong thing, so the distinction is part of the API rather
than something each agent has to infer.

---

## Configuration

Everything comes from the environment; nothing secret is written to disk by the app.

| Var | Required | Notes |
|---|---|---|
| `AGENT_TOKENS` | yes | Comma-separated. May create requests. |
| `CLIENT_TOKENS` | yes | Comma-separated. May read and answer. Must not overlap agent tokens. |
| `PORT` | no | Default `8790`. |
| `DB_PATH` | no | Default `./data/tether.db`. |
| `DEFAULT_TIMEOUT_SEC` | no | Default 3600. |
| `FISH_API_KEY` | no | Enables `speak` and `voice: true`. Without it, voice degrades to text. |
| `FISH_REFERENCE_ID` | no | Your chosen voice model. |
| `VOICE_LEAD_IN_MS` | no | Default 700. Silence prepended so a waking speaker eats the silence, not your first word. |
| `VOICE_SPEED` / `VOICE_TEMPERATURE` / `VOICE_TOP_P` | no | Fish delivery tuning. Defaults 0.95 / 0.7 / 0.7. |
| `DEFAULT_TIMEZONE` | no | IANA zone schedules default to. **Set this** — the NAS runs UTC and you don't. |
| `PUBLIC_URL` | for buttons | How your phone reaches this server, e.g. `http://192.168.0.3:8790`. Required for tappable ntfy buttons. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | Optional. Needs a phone number. |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | no | **Ask-capable** when `PUBLIC_URL` is set — notifications carry tappable answer buttons. |
| `FCM_CREDENTIALS` | for the app | Path to the Firebase service-account JSON. Without it the `app` channel is never registered and the phone never rings. |
| `CALL_RING_SECONDS` | no | Default 45. How long a call rings before the server marks it missed. |

**You don't need any third-party account.** Two channels work with nothing external:

- **The web UI** at `/` — open it in any browser, including your phone's. Live over WebSocket, with
  answer buttons. Add it to your home screen and it behaves like an app.
- **ntfy action buttons** — if you already run ntfy, requests arrive as notifications carrying tappable
  Yes / No / Refuse buttons that answer directly from the notification shade.

Telegram is supported but entirely optional — it needs a phone number, which is a real cost for a
notification channel. Skip it unless you want off-LAN delivery before you've sorted out a proxy host.

---

## API

| Route | Auth | Purpose |
|---|---|---|
| `ALL /mcp` | agent | Streamable HTTP MCP endpoint |
| `GET /api/server` | client | This server's name and every address it can be reached at, including the one this request arrived on |
| `GET /api/requests` | client | Pending list (`?all=1` for history) |
| `POST /api/requests/:id/answer` | client | `{"answer":"..."}` or `{"refused":true}` |
| `GET /api/stream?token=` | client | WebSocket: live feed, sends the backlog on connect |
| `GET /audio/:id` | client | Voice message playback |
| `GET /v/:id/:token` | per-request | Recording playback, safe to put in a notification |
| `GET /api/schedules` | client | Schedules, with their next firings |
| `POST /api/schedules` | client | Create a schedule |
| `POST /api/schedules/:id/enabled` | client | Pause / resume |
| `DELETE /api/schedules/:id` | client | Delete a schedule |
| `POST /a/:id/:token` | per-request | One-tap answer for notification buttons |
| `POST /api/pair/start` | client | Mint a pairing code (5-minute TTL, single use) and render its QR. Optional `{"url"}` picks the address the QR points at. |
| `GET /api/pair/status/:code` | client | Has that code been claimed, and by which device |
| `POST /api/pair/claim` | none | Trade a pairing code for a per-device client token |
| `GET /api/devices` | client | Paired devices. Never echoes a device's token. |
| `POST /api/devices/push-token` | device | Register or rotate this device's FCM token |
| `DELETE /api/devices/:id` | client | Revoke one device |
| `GET /api/calls` | client | Call history |
| `POST /api/calls/:id/answer` | device | Pick up. 409 means another device won the race. |
| `POST /api/calls/:id/decline` | device | Decline |
| `POST /api/calls/:id/end` | device | Hang up |
| `GET /api/call/:id/stream` | device | WebSocket: call state and audio segments |
| `GET /` | none | Web UI (asks for a token, then talks to the authenticated API) |
| `GET /health` | none | Liveness |

---

## Deploying

```bash
cp .env.example .env       # fill it in first
docker compose up -d
```

There's no build stage inside the image: Node 24 strips TypeScript natively, so the source you edit is
the code that runs. SQLite is `node:sqlite` from the standard library, so there's no native module to
compile and nothing to rebuild per architecture — which is also why a multi-arch image is free rather
than a cross-compilation problem.

The base image is pinned to a Node minor rather than `:latest`. This image is meant to be published, and
"whatever Node was current when you pulled" is not a reproducible build.

**What needs to be a real path, not a container-internal one:** `PUBLIC_URL`. It is embedded in the call
push as the audio URL, so it has to be how the *phone* reaches the server — not how you reach it from
the same LAN, if those differ.

If you want the Android app, mount the Firebase service-account key read-only and point
`FCM_CREDENTIALS` at it. Without it the server starts fine and simply never registers the `app` channel;
`GET /health` tells you which channels are live.

### Publishing the image

`.github/workflows/publish-image.yml` builds `linux/amd64` + `linux/arm64` and pushes to GHCR on a
version tag. Tag-driven rather than push-driven on purpose: `:latest` moving with every commit to main
is how self-hosters end up running a half-finished refactor.

---

## The Android app

`android/` is a Kotlin/Compose app whose job is to make an agent's call behave like a phone call:
the screen lights up, a ringing screen takes over, and answering starts the agent talking.

```bash
cd android && ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Pairing

Scan a QR code. Either side can produce one:

```bash
npm run pair                                   # from a checkout
docker exec -it tether node src/cli/pair.ts    # from the container
```

That prints a scannable code in the terminal and waits until a phone claims it. It needs **no token**:
anything that can run a process next to the database is already more privileged than a client token, so
making the operator go and find one first would be ceremony, not security.

The web UI has the same thing behind **Pair phone** in the header — a QR, a countdown, and a dropdown of
addresses the phone might use, because only a human knows whether the phone will be on the same wifi as
the server or coming in over the internet. Guessing wrong yields a QR that scans and then cannot connect.

The QR carries `tether://pair?v=1&u=<server>&c=<code>` — an address and a code that dies in minutes.
**Never a token**, so a QR left on a screen or in a screenshot is not a credential. Scanning uses Google's
code scanner, which runs the camera in Play Services rather than in the app, so the app holds no `CAMERA`
permission. Typing the address and code by hand still works and is one tap away.

What comes back is a token scoped to **that device**, not a copy of `CLIENT_TOKENS`, so a lost phone is
revoked with one `DELETE /api/devices/:id` instead of a rotation that logs out everything else.

Two things must be true for the phone to actually ring, and the app says so on screen when they aren't:

- `FCM_CREDENTIALS` is set server-side, so the `app` channel exists.
- The app holds `USE_FULL_SCREEN_INTENT`. Android 14 auto-grants this only to apps Play classifies as
  calling or alarm apps; until Tether is published in that category it has to be granted by hand, and
  without it a call arrives as a card in the shade instead of a ringing screen.

### One server, several addresses

A device is authenticated by its token, not by the route it arrived on. The same server is
`192.168.0.2` from the sofa and a tailnet address from a cafe, and it will happily answer both --
so an app that stored a single address was stranded the moment the network changed, which is
exactly when a tool for reaching a stuck agent matters most.

So the app keeps a **named server with an ordered list of addresses**. Settings lets you rename it,
add an address, remove one, or promote one, at any time after pairing -- no re-pairing involved.

- Requests try each address from the top until one answers, and whichever works is promoted to the
  top. The cost of being on the wrong network is paid once per network change, not once per request.
- Failover happens **only** on a transport error. An HTTP status means a server answered, and it is
  this server: retrying a `409 someone else already answered that call` against a second address
  would answer the call twice.
- Every address after the first gets a 3-second connect timeout rather than 10. Anything reachable
  completes a handshake well inside that, and ten seconds per dead address is an eternity when the
  phone is ringing.
- `GET /api/server` returns the server's name and every address it can see -- including the one the
  request arrived on, read off the `Host` header. That is how a phone paired at home discovers its
  away-from-home address: open the app once while away and it is offered as a suggestion.

Suggestions are offered rather than added silently, because the server's list includes every
interface it has, and a docker bridge or a second NIC the phone will never reach is a dead end that
would cost a real timeout on every failover.

See [android/README.md](android/README.md) for the build, the signing setup, and the Play notes.

---

## Design decisions worth knowing

**Stateless MCP transport.** Each request builds a fresh server. Blocking tool calls are held open by the
HTTP request itself, and all durability lives in SQLite — so a restart loses no answers.

**Long-poll under a blocking API.** `ask` looks blocking to the agent but re-polls in ~55s legs
internally, so no connection is pinned on state the server can't rebuild.

**Answers race exactly once.** The resolve is a guarded `UPDATE ... WHERE status='pending'`, so the phone
and the web UI can't both win. The loser gets a 409 and the current state.

**Audio is a cache — except when it isn't.** Voice blobs are pruned after 48h, because the text says the
same thing and can be re-rendered. Call recordings are stored with `keep` and survive the sweep: a
recording is the only artefact of the call, not a convenience copy of something else.

**Voice messages open with silence.** Fish returns complete audio — speech at full RMS by 100ms. The
loss is at playback: an idle speaker takes a few hundred ms to wake and eats whatever plays meanwhile,
so the first word disappears. Every message gets `VOICE_LEAD_IN_MS` of silence prepended, built by
concatenating copies of one 417-byte silent MPEG frame. MP3 frames are self-contained, so this is pure
byte concatenation — no decoder, no ffmpeg, no runtime dependency.

**Schedules live in the database, not in a crontab.** Host cron could curl the API, but then the agent
can't read, edit or reason about its own reminders. Each schedule carries an IANA timezone, because the
NAS runs UTC and you don't. Firing is guarded by the zoned minute key, so a slow tick can't skip a slot
and a restart can't replay one.

**Push is data-only, never a `notification` payload.** A `notification` payload is rendered by Android
itself while the app is backgrounded — which is exactly when a call arrives. That would turn a ring into
a silent card. Data-only messages are delivered to app code instead, so the app decides whether a payload
becomes a ringing screen or a message, and `android.priority: HIGH` is set explicitly or Doze delays it.

**The call push is self-contained.** Everything the ringing screen needs — title, agent, action token,
audio URL — travels in the payload, so a phone waking from Doze on a bad connection can draw the screen
with no round-trip. The network is needed only once you pick up.

**Devices get their own tokens.** Pairing mints a per-device credential rather than handing out a shared
client token, and revoking a stolen phone is then a one-row change. The pairing code itself is the
boundary: single-use, five-minute TTL, claimed through the one unauthenticated route in the app.

**The QR encoder is vendored, not a dependency.** `src/qr.ts` is a complete byte-mode QR implementation
in about 300 lines. A QR matrix is arithmetic over a fixed spec — no I/O, no platform quirks, nothing
that rots — and this image is meant to be published, so the maths is cheaper to audit than another
dependency tree on the one code path that hands out credentials. It is verified against the `qrcode`
package across all 40 versions, 4 EC levels and 8 masks at exact capacity, and round-trips through a
decoder.

**Notification buttons carry a single-purpose token, not a client token.** Each request gets its own
`actionToken`, and `POST /a/:id/:token` answers exactly that one request. A notification payload is a
comparatively exposed place — screen previews, ntfy's own message cache — so whatever authorises it must
be useless for anything else. A leaked one can answer one question that was already being asked; it
cannot read your history or answer anything future.

---

## Releases and versioning

The version lives in `package.json` and nowhere else. The Android app reads it at build time, so
the server and the APK can never disagree about what they are.

Work happens on `dev`. A release is cut by opening a PR from `dev` into `main` and merging it —
nothing else cuts one, so a release cannot happen by accident. On merge, CI bumps the version,
tags it, builds a **signed** APK, and publishes a GitHub release with the APK attached.

Semver, with the bump chosen in this order:

| Bump | When | How to ask for it |
|---|---|---|
| **major** — `X`.y.z | A breaking change | `major` label, or a `feat!:` title, or `BREAKING CHANGE` in the body |
| **minor** — x.`Y`.z | A new feature, backwards compatible | `minor` label, or a `feat:` title |
| **patch** — x.y.`Z` | A fix or a chore | `patch` label, or nothing — this is the default |

Defaulting to patch is deliberate: the common case is a fix, and guessing wrong in that direction
costs a version number rather than a broken upgrade.

The signing key is held as repository secrets (`ANDROID_KEYSTORE_BASE64` and friends). **Losing it
means never being able to update an installed app** — Android refuses an update signed by a
different key — so it is backed up outside CI as well.

## Roadmap

| Stage | Scope | State |
|---|---|---|
| 1 | Server, MCP, `ask`, Telegram + ntfy fan-out | **done** |
| 2 | Web UI — pending queue, history, live over WebSocket | **done** |
| 3 | Android app — push, ringing screen, reply, action buttons | **done** (not yet on Play) |
| 4 | `request_secret` via SMS User Consent API | |
| 5a | Calls — speak at max priority, recording kept and replayable | **done** |
| 5b | Schedules — recurring jobs fired with no agent running | **done** |
| 5c | Live two-way calls, turn-based over the existing WebSocket | **done** |
| 5d | User-initiated calls (call the agent) | |
| 6 | Session registry — live Claude Code sessions and subagents, and a relay that carries a reply back into one | **done** |

See [`docs/sessions-and-agents.md`](docs/sessions-and-agents.md) for how sessions and agents work, including why the OTP
feature needs a mandatory confirmation step.

## License

MIT (intended).
