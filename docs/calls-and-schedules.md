# Calls and schedules

Two features that go together: a message that **rings through and is kept**, and a way to fire one
**with no agent running**.

The driving case: seedlings that have to go out in the morning sun and come back in at dusk, logged
daily. A notification gets swiped away. A Claude session that would remind you isn't running at 07:00.

---

## Calls

### What a call actually is

Stage 1 is **not** telephony. There is no carrier, no SIP trunk, no phone number. A `call` is:

1. render the message to speech,
2. push it at **priority 5**, which breaks through Do Not Disturb,
3. attach the recording so it plays from the notification,
4. **keep** that recording so it can be replayed later.

That is deliberately the useful 80%. What makes a phone call work as a reminder isn't the dial tone —
it's that it arrives loudly, says something, and can be listened to again.

**Since 2026-08-28 there is a second, better path.** With the Android app paired, a call is pushed to
the phone as a data-only FCM message and rings a full-screen incoming-call screen — the device wakes,
the screen lights up, and answering starts the speech. Same recording model underneath; what changed is
that the delivery is a ring rather than a notification you might scroll past. The ntfy path remains as
the fallback for a phone with no app on it.

A live two-way call and calling *in* (stages 5c/5d) build on this rather than replacing it: the app
already owns audio focus, the call state machine, and a per-call WebSocket.

### Why the recording survives the pruner

Voice blobs are normally a cache, pruned after 48h, because the text says the same thing and can be
re-rendered. **A call recording is not a cache** — it is the only artefact of the call. So it is stored
with `keep = 1`, which exempts it from the sweep.

### Priority is not negotiable

A call always goes out at ntfy priority 5, whatever the caller asked for. If it shouldn't ring through,
it shouldn't have been a call. `notify` and `speak` remain the quiet options.

### Delivery

| Channel | How it arrives |
|---|---|
| **app** | A ringing phone. Data-only FCM push → full-screen incoming-call screen → the agent speaks when you answer. This is the real one; the rest are fallbacks. |
| ntfy | Priority 5 with the MP3 uploaded as a real attachment, playable from the shade. Tapping opens the recording. |
| Telegram | `sendAudio` with the bytes uploaded — an inline player in the chat. |
| Web UI | A **Calls** section that keeps recordings playable after the request settles. |

The `app` channel does not double up: `sendApp()` returns early for `kind === 'call'`, because the call
is already being rung by `callsession.ring()`. Sending both would deliver the same call twice.

The bytes are *uploaded* to both, never passed as a URL. Telegram's servers and your phone off-LAN
would both have to resolve that URL, and the NAS isn't publicly reachable — an attachment link nobody
can fetch is worse than no attachment. If ntfy rejects the upload (attachments can be disabled
server-side) the message is re-sent as plain text: losing the audio is acceptable, losing the message
is not.

### Playback authorisation

Recordings are served from `GET /v/:id/:token`, authorised by the **request's own action token**, not a
client token. The URL sits inside a notification payload and has to be openable by whatever handles the
tap — so the credential in it unlocks exactly one recording and nothing else.

---

## The lead-in

> "If I tell it to say *Tonight the experiment holds*, what you hear is *night the experiment holds*."

**Fish is not the problem.** Measured on raw Fish output: `silence_start: 0`, `silence_end: 0.051`,
full RMS by 100 ms. The audio is complete.

The loss is at **playback**. An idle audio endpoint — Windows WASAPI, an Android speaker waking, a
browser starting a stream — takes a few hundred milliseconds to actually produce sound, and it eats
whatever was playing meanwhile. With only 51 ms of head, the first word is what gets eaten.

So every voice message gets `VOICE_LEAD_IN_MS` (default 700) of silence prepended. The silence is
disposable; the first word is not.

### How it's done

By concatenating copies of **one 417-byte silent MPEG-1 Layer III frame** (128 kbps, 44.1 kHz, mono,
26.122 ms). MP3 frames are self-contained, so this is a pure byte concatenation — no decoder, no
ffmpeg, no runtime dependency, and the duration is tunable by repeat count.

Verified additive: 0.704 s of frames + 2.011 s of speech decodes to exactly 2.715 s, speech intact.

Requests to Fish pin `mp3_bitrate: 128` and `sample_rate: 44100` so the format always matches. If the
returned stream doesn't match (different rate, stereo, an ID3 header), the lead-in is **skipped with a
warning** rather than spliced — a slightly clipped message is a much better failure than a corrupted
one.

The same technique is in `X:\ai.tools\tools\say.ps1` (`-LeadInMs`, default 700), so the standalone
speech tool behaves identically.

---

## Delivery markers

The `s2.x` models accept free-form natural-language cues in **square brackets**, inline, anywhere:

```
[warmly] Morning. [pause] Time to put the seedlings out.
[sounding slightly concerned] The build has failed twice now.
```

They're open-domain rather than a fixed enum — `[sounding slightly concerned]` works as well as
`[worried]`. The older `s1` model used `(parentheses)` with a fixed tag set instead; worth knowing if
`FISH_MODEL` is ever changed.

Markers are passed through untouched. There is no validation, because the valid set is effectively
unbounded.

---

## Schedules

A recurring job **Tether itself** fires. No agent attached, no session alive.

### Why not host cron

Host cron could `curl` the API. But then the schedule lives in a crontab the agent can't read, edit or
reason about. Keeping it in Tether's database means an agent creates, lists and deletes schedules
through the same MCP surface as everything else — and the web UI can show what's pending without
shelling into the NAS.

### Why the timezone is per schedule

The NAS runs UTC. You don't. `07:00` is meaningless without a zone, and a fixed offset drifts an hour
twice a year — for a morning reminder, the difference between useful and useless. Each schedule carries
an **IANA zone**, and matching happens against wall-clock time in that zone. `Intl` does the DST
arithmetic.

### Cron support

Standard 5 fields: `minute hour day-of-month month day-of-week`.

Supported: `*`, `n`, `a-b`, `*/n`, `a-b/n`, comma lists, month and weekday names (`jan`, `mon`),
Sunday as either `0` or `7`, and the classic OR rule — when **both** day fields are restricted, either
may match.

Invalid expressions are rejected at creation time with a readable reason, not silently at 3am.

### Firing is idempotent

The loop ticks every 20s — more often than once a minute, so a slow tick can't skip a slot. The guard
is `last_fired_minute`, the zoned minute key (`2026-08-28T07:00`), written **before** delivery is
awaited. A second tick inside the same minute, or a restart inside it, will not send twice.

### The seedlings, concretely

```
schedule_create  cron="0 7 * * *"    timezone="Africa/Gaborone"  kind="call"
                 title="Seedlings out"
                 body="[warmly] Morning. [pause] Time to put the seedlings out in the sun."

schedule_create  cron="30 17 * * *"  timezone="Africa/Gaborone"  kind="call"
                 title="Seedlings in"
                 body="[gently] Evening. Bring the seedlings back in, and log today's growth."
```

`schedule_create` returns the next few firings in the schedule's own zone. Read them back before
confirming — a reminder at the wrong hour is worse than no reminder.

---

## MCP tools

| Tool | Blocks | What it's for |
|---|---|---|
| `call` | only with `choices` + `wait` | Speak at max priority, keep the recording. |
| `schedule_create` | no | Recurring job. Validates cron and timezone; returns the next firings. |
| `schedule_list` | no | Everything scheduled, including other sessions' jobs. |
| `schedule_delete` | no | Remove one by id. |

`call` and `speak` are only registered when `FISH_API_KEY` is set. Without it a call still goes out —
as an urgent text message — because a failed TTS must never swallow the message.

## REST

| Route | Auth | Purpose |
|---|---|---|
| `GET /v/:id/:token` | per-request | Recording playback (notification-safe) |
| `GET /api/schedules` | client | List, with next firings |
| `POST /api/schedules` | client | Create |
| `POST /api/schedules/:id/enabled` | client | `{"enabled":false}` to pause |
| `DELETE /api/schedules/:id` | client | Delete |
