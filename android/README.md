# Tether for Android

A messaging and calling app for your agents. Not a notification client — an agent that needs you
**rings the phone**, the screen lights up, and when you pick up it starts talking.

- **minSdk 26**, targetSdk 36, Kotlin 2.1 + Compose, single module.
- Push over **FCM HTTP v1**, data-only.
- No ntfy, no third-party notification service in the path.

---

## Build

```bash
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` must point at an Android SDK with platform 36 installed. It is gitignored, as is
every build directory.

---

## Pairing

The app ships with no credentials. Tap **Scan QR code** on the first screen and point it at a code from
the server:

```bash
npm run pair                                   # from a checkout
docker exec -it tether node src/cli/pair.ts    # from the container
```

— or open the server's web UI and tap **Pair phone**. Both show the same QR and both wait for the scan.

The QR carries `tether://pair?v=1&u=<server>&c=<code>`: the address and a `XXXX-XXXX` code good for five
minutes and one use. It is never a token, so a QR on a screen or in a screenshot is not a credential.
What the claim returns *is* a token — scoped to this device, and what every later request uses.

### Why there is no CAMERA permission

Scanning goes through `play-services-code-scanner`. Google's code scanner runs the camera preview inside
Play Services, in a separate process, and hands back only the decoded string. So pairing costs the user
one tap instead of a camera grant, and the app never holds a permission it would otherwise carry forever
for a one-time setup step. The app already requires Play Services for FCM, so this adds no new
requirement — and if the scanner is genuinely unavailable, the screen falls back to manual entry and
says why.

A `tether://pair` link tapped anywhere else — a message, a note — opens the app and pairs directly, via
the `VIEW` intent filter on `MainActivity`. A private scheme rather than an https App Link on purpose:
App Links need a verified domain, and this app pairs with whatever server its user happens to run.

Manual entry is still there, folded behind **Enter details manually**, for a server reached over a VPN
with no second screen to hand.

Unpairing from the app only clears the phone. To stop the server trusting a device you no longer have,
`DELETE /api/devices/:id`.

### Plain HTTP is allowed

Most Tether servers live at `http://192.168.x.x:8790` with no certificate, and since Android 9 the
platform blocks cleartext by default — which surfaces as a pairing failure that reads like the server is
down. `res/xml/network_security_config.xml` permits it. There is no narrower rule: the config can only
exempt named domains, and the address is whatever the user types or scans.

Use HTTPS as soon as there is a proxy or tunnel in front of the server. The pairing claim and the device
token both cross this connection, and on a shared network cleartext means anyone on it can read them.

---

## What has to be true for it to ring

The app checks both and puts a banner at the top of every tab when either is missing, because a phone
that has silently stopped ringing looks identical to one with nothing to say.

| Condition | Where | If missing |
|---|---|---|
| `FCM_CREDENTIALS` set | server | The `app` channel is never registered; nothing is pushed at all. |
| `POST_NOTIFICATIONS` granted | phone, Android 13+ | Calls still ring, silently. |
| `USE_FULL_SCREEN_INTENT` granted | phone, Android 14+ | The call arrives as a heads-up card, not a ringing screen. |

The third one is the interesting one. Android 14 auto-grants `USE_FULL_SCREEN_INTENT` only to apps Play
classifies as calling or alarm apps. Until Tether is published in that category it must be granted by
hand — the banner's **Allow** button opens the right settings page.

---

## How a call actually works

1. The server pushes a data-only, high-priority FCM message with everything the screen needs.
2. `TetherMessagingService` starts `CallService` **synchronously** — FCM allows roughly ten seconds of
   foreground-service-launch grace, so nothing slower may happen first.
3. `CallService` calls `startForeground` immediately, then rings: system ringtone through
   `USAGE_NOTIFICATION_RINGTONE`, vibration, wake lock.
4. The ringing screen is surfaced twice over — a full-screen intent on a high-importance notification,
   *and* a direct `startActivity`. The system suppresses full-screen intents while the device is in
   active use, and a call that only shows up when you happen to be holding the phone defeats the point.
5. Answering `POST`s to the server. Exactly one device wins that race; the losers get 409 and dismiss
   quietly, which is normal rather than an error.
6. The winner downloads the audio and plays it with `USAGE_VOICE_COMMUNICATION` in
   `MODE_IN_COMMUNICATION` — earpiece by default, like a call, with a speaker toggle.

`CallController` holds the only copy of call state. The Activity and the notification are both views
onto it, so a rotation, a swipe-away, or the system killing the screen mid-ring cannot desynchronise
them.

### Why `mediaPlayback` and not `phoneCall`

`foregroundServiceType="phoneCall"` requires `MANAGE_OWN_CALLS` and a self-managed `ConnectionService`;
declaring it without one crashes on Android 14. What the service does today is play audio, so
`mediaPlayback` is both honest and the one that works. A real `ConnectionService` is the upgrade path
when calls become two-way (roadmap 5c).

---

## Messages

The second surface. Questions from agents arrive as notifications whose choices are real action
buttons — `MessageActionReceiver` answers the server directly, using `goAsync()` so a slow POST on
mobile data isn't killed halfway. In-app, the same questions are cards with the same buttons, plus
history.

---

## Publishing to Play

Not done yet. What it needs:

- A release signing config. Keep the keystore **outside** this repo; `*.jks` and `*.keystore` are
  gitignored as a backstop, not as the plan.
- `isMinifyEnabled = true` and a pass over the ProGuard rules once the surface stops changing.
- A Play Console declaration for the **calling app** category, which is what makes
  `USE_FULL_SCREEN_INTENT` auto-granted rather than manual.
- A privacy policy URL. The app collects nothing and talks only to the server you point it at, which
  makes the policy short but not optional.

`google-services.json` is committed on purpose: it holds no secret, only the Firebase project's public
identifiers. The service-account key that lets the *server* send pushes lives outside the repo, at the
path `FCM_CREDENTIALS` names.
