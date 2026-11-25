# Telegram integration — setup

FLASH on Telegram: the owner chats with FLASH from Telegram, and FLASH
nudges him about real overdue / due-today tasks and high model usage.
No live bot test is possible until the values below exist — the code is
built and tested with mocks; the first real message is the live test.

## 1. Create the bot (owner does this, ~2 minutes)

1. In Telegram, message **@BotFather** and send `/newbot`.
2. Pick a display name (e.g. `FLASH`) and a username ending in `bot`
   (e.g. `flash_assistant_bot`).
3. BotFather replies with a token like `123456789:AAE...` — that is
   **TELEGRAM_BOT_TOKEN**. Never paste it in chat, a file, or a commit;
   put it straight into Vercel (step 3) and nowhere else.

## 2. Find your numeric Telegram user id

Message **@userinfobot** in Telegram — it replies with your numeric id
(e.g. `123456789`). That is **TELEGRAM_USER_ID**. Only this id can use
the bot: anyone else gets no reply at all.

## 3. Invent a webhook secret

Pick any random string (e.g. from a password generator). That is
**TELEGRAM_WEBHOOK_SECRET**. Telegram sends it back on every webhook
call; the server rejects any call without it.

## 4. Set the env vars in Vercel

Vercel project `flash` → Settings → Environment Variables, scope
Production (and Preview if you want to test the bot against a preview
deployment):

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the BotFather token |
| `TELEGRAM_USER_ID` | your numeric id from @userinfobot |
| `TELEGRAM_WEBHOOK_SECRET` | the random string from step 3 |
| `TELEGRAM_PROACTIVE_SECRET` | only if you trigger the proactive check from outside Vercel Cron (Vercel sets `CRON_SECRET` automatically for its own Cron jobs) |

Redeploy after adding them — env vars only take effect on a new
deployment.

## 5. Register the webhook (after deployment)

Tell Telegram where to send updates. Replace `<deployment>` with the
deployed host (e.g. `flash-flame-nu.vercel.app`) and `<token>` /
`<secret>` with the values above, and open this URL once in a browser
(or `curl` it):

```
https://api.telegram.org/bot<token>/setWebhook?url=https://<deployment>/api/telegram/webhook&secret_token=<secret>
```

Telegram replies `{"ok":true,...}`. The webhook URL is
`https://<deployment>/api/telegram/webhook` — it must be set after
deployment, and again after any deployment-host change. (Long polling
is deliberately not used: the app runs serverless on Vercel, so a
webhook endpoint is the only shape that fits.)

## What works over Telegram

- Any text message goes through the same chat pipeline as the web chat:
  same model (Groq, OpenRouter hot-swap), same memories, same tools.
- Commands: `/start` `/help` `/tasks` `/usage` `/stop` `/resume`.
- If the model proposes creating a task or saving a memory, it becomes
  a pending approval exactly as on the web — approve or reject it in
  the FLASH web app. Telegram cannot approve actions.
- Voice and attachments are out of scope: send text.

## Proactive nudges

- Schedule: Vercel Cron, once a day at **09:00 IST** (`30 3 * * *`
  UTC in `vercel.json`). Vercel's Hobby plan allows daily crons.
- Triggers, from real state only: overdue tasks (one nudge each),
  tasks due today (one combined nudge), model usage at or above 80%
  of the daily cap (one nudge). At most 3 nudges per run.
- Dedupe: each nudge has a stable key stored in `telegram_nudges`,
  so the same fact is never nudged twice. Every sent nudge is also
  logged in the activity timeline (`action_logs`, tool
  `telegram_proactive`).
- Quiet hours: nothing is ever sent 23:00–07:00 IST.
- Off switch: send `/stop` to the bot (or `/resume` to turn nudges
  back on). The switch lives in `settings.telegram_proactive_enabled`.
- Manual trigger: `POST /api/telegram/proactive` with header
  `Authorization: Bearer <CRON_SECRET or TELEGRAM_PROACTIVE_SECRET>`.
  Without a secret configured, the route refuses every call.
