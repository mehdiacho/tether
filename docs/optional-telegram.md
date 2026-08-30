# Telegram setup

Five minutes, and it makes Tether fully usable from your phone **today** — no app needed.

Telegram is a genuine `ask` channel, not just push: choices become inline buttons, so you answer an
agent's question by tapping in the chat. That's what lets you find out whether blocking-ask is the right
shape before committing to build Android.

---

## 1. Create the bot

In Telegram, message **[@BotFather](https://t.me/BotFather)**:

```
/newbot
```

Give it a name (`Tether`) and a username ending in `bot` (`mehdi_tether_bot`). BotFather replies with a
token like `8123456789:AAH...`. That's `TELEGRAM_BOT_TOKEN`.

## 2. Get your chat id

Send your new bot any message (`hi`) — a bot cannot start a conversation with you, so this step is
required, not optional. Then:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | python -c "import sys,json;d=json.load(sys.stdin);print([u['message']['chat']['id'] for u in d['result'] if 'message' in u])"
```

That prints your chat id — a number like `123456789`. That's `TELEGRAM_CHAT_ID`.

## 3. Configure

In `.env`:

```
TELEGRAM_BOT_TOKEN=8123456789:AAH...
TELEGRAM_CHAT_ID=123456789
```

Restart. Startup should log `channels: telegram`.

## 4. Test

```bash
./test-flow.sh
```

The `ask` step will now also appear in your Telegram chat with **Yes / No / ✕ Refuse** buttons. Tap one
and the agent's blocked call returns with your answer.

---

## Notes

- **Long-polling, not webhooks.** No public URL required, so this works while the server is still
  LAN-only. Worth keeping even after a proxy host exists — one less thing to expose.
- **Buttons send an index, not the text.** Telegram caps `callback_data` at 64 bytes, so a long choice
  label would silently break the button. The server sends the choice index and maps it back.
- **Refuse is always offered.** "No answer" and "explicitly declined" are different states the agent
  reasons about differently, so the human always has a way to say no rather than just ignoring it.
- **Anyone who finds your bot can message it**, but only `TELEGRAM_CHAT_ID` receives requests, and button
  presses are matched against real pending request ids. A stranger messaging the bot achieves nothing.

## Adding ntfy alongside

The ntfy server already on the NAS can run in parallel — push-only, so it announces but cannot answer:

```
NTFY_URL=http://192.168.0.2:8010
NTFY_TOPIC=claude-alerts
NTFY_TOKEN=<from ~/.secrets/ntfy.env>
```

Useful while migrating: the same request reaches both, and you can compare which one you actually
respond to.
