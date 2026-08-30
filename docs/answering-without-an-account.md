# Answering without a third-party account

Two ways to answer an agent's question that need no external service, no signup, and no phone number.
Both work today.

---

## 1. The web UI

Open the server's root in any browser:

```
http://192.168.0.3:8790/
```

First visit asks for a **client token** (from `CLIENT_TOKENS` in `.env`). It's stored in `localStorage`,
so you paste it once. You can also link straight in with `?token=…` — the page strips it from the URL bar
immediately afterwards so the secret isn't left sitting in history or a screenshot.

What you get:

- Pending requests, newest first, with the agent's context
- Tappable choices, a free-text box when the question is open-ended, and **Refuse** on everything
- Live updates over WebSocket — a new question appears without a refresh, and one answered elsewhere
  disappears
- Voice messages play inline
- Recent history, so you can see what you already answered
- Reconnects by itself after the phone sleeps

**On a phone:** open it in Chrome and use *Add to Home screen*. It launches like an app, and buttons are
sized for one-handed use.

**Why the page itself isn't authenticated:** it's an empty shell that asks for a token and then talks to
the authenticated API. Serving it freely is what lets you bookmark it without a secret in the URL.

---

## 2. ntfy action buttons

If you already run ntfy — you do — questions arrive as notifications with **tappable answer buttons**.
Answer from the notification shade without opening anything.

Set both of these in `.env`:

```
PUBLIC_URL=http://192.168.0.3:8790
NTFY_URL=http://192.168.0.2:8010
NTFY_TOPIC=claude-alerts
NTFY_TOKEN=<from ~/.secrets/ntfy.env>
```

`PUBLIC_URL` is how your **phone** reaches Tether, not how the server reaches itself. Get it wrong and
the notification arrives but the buttons do nothing.

### How the buttons are safe

Each request carries its own single-purpose `actionToken`, and the button POSTs to
`/a/:id/:actionToken`. **A client token never appears in a notification.**

That matters because a notification payload is a comparatively exposed place — lock-screen previews, and
ntfy's own 72h server-side message cache. So whatever authorises the button has to be useless for
anything else. A leaked action token can answer one question that was already being asked. It cannot read
your history, and it cannot answer anything else. Spent tokens return 409 rather than silently
re-resolving.

Verified by `test-flow.sh`: a wrong token gets 404, the right one gets 200, and a replayed one gets 409.

### Limits

- **ntfy allows at most 3 buttons.** Choices are capped at 2 plus Refuse; anything richer needs the web UI.
- **LAN or Tailscale only** until Tether has a public hostname. Off-network, notifications still arrive
  (ntfy is reachable) but the buttons can't reach Tether. The web UI has the same boundary.

---

## Which to use

Use **ntfy buttons** for the common case — a yes/no you want to clear in one tap without unlocking
properly. Use the **web UI** for free-text answers, more than two choices, reading context before
deciding, or catching up on several pending items at once.

They're the same underlying request; answering in either place resolves it in both, and the loser of any
race gets a clean 409 rather than a conflicting answer.

---

## Telegram

Still supported (`docs/optional-telegram.md`), but it needs a phone number, which is a real cost for a
notification channel. The only thing it currently buys over the two above is **off-LAN delivery with
working buttons**, since Telegram's servers reach you anywhere. Once Tether has a proxy host, that
advantage disappears.
