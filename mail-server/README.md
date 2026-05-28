# ScrapeFlow Mail Server

A small self-hosted backend that gives the ScrapeFlow MCP server disposable
inbox capabilities. Once running, the AI can call `create_temp_email`, paste
the resulting address into a signup form, then `wait_for_email` to receive the
verification link or code — all autonomously.

## What it does

- Accepts inbound SMTP for a catch-all domain you own (port 25), **or** accepts
  forwarded raw email via `POST /api/incoming` (Cloudflare Email Worker,
  Mailgun route, Postmark inbound, etc.).
- Stores inboxes and parsed messages in SQLite.
- Exposes a REST API for creating inboxes, listing/reading messages, and
  long-polling for new mail.
- Auto-extracts verification codes (4–8 digits, ranked by proximity to
  keywords like "verification" / "code" / "OTP") and links from each message.
- Sweeps expired inboxes on a schedule.

## REST API

All endpoints require `Authorization: Bearer <API_KEY>` (or `?key=<API_KEY>`).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/inboxes` | Create an inbox. Body: `{ label?, local_part?, ttl_ms? }`. |
| `GET` | `/api/inboxes/:id` | Get inbox metadata. |
| `DELETE` | `/api/inboxes/:id` | Delete inbox + messages. |
| `GET` | `/api/inboxes/:id/messages?since_ms=&limit=` | List messages. |
| `GET` | `/api/inboxes/:id/messages/:msgId` | Full message (text + HTML). |
| `GET` | `/api/inboxes/:id/wait?since_ms=&timeout_ms=` | Long-poll for new mail. |
| `POST` | `/api/incoming` | Webhook for inbound mail. |
| `GET` | `/healthz` | Public health check. |

### Webhook ingest formats

`POST /api/incoming` accepts either:

1. Raw RFC822 with `Content-Type: message/rfc822` and recipients in
   `X-Recipients: addr1@..., addr2@...`, or
2. JSON: `{ "raw": "<rfc822 string or base64>", "raw_encoding": "base64" | "utf8", "recipients": ["addr@..."], "to": "addr@..." }`.

If recipients aren't explicit, the server falls back to the parsed `To:` header.

## Configuration

Copy `.env.example` to `.env` and edit. Required: `MAIL_DOMAIN`, `API_KEY`.

## Local dev (HTTP only, no SMTP)

```bash
cd mail-server
npm install
cp .env.example .env   # set MAIL_DOMAIN and API_KEY
echo "SMTP_PORT=" >> .env   # disable SMTP locally
npm run dev
```

Smoke-test it:

```bash
API=http://127.0.0.1:8080
KEY=...your API_KEY...

INBOX=$(curl -s -X POST $API/api/inboxes -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" -d '{"label":"smoke"}')
echo $INBOX

INBOX_ID=$(echo $INBOX | jq -r .id)
ADDR=$(echo $INBOX | jq -r .address)

# Fake an inbound email
curl -s -X POST $API/api/incoming -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" -d "$(jq -n --arg to "$ADDR" '{
    recipients: [$to],
    raw: "From: noreply@github.com\r\nTo: \($to)\r\nSubject: Verify\r\n\r\nYour code is 482917"
  }')"

curl -s $API/api/inboxes/$INBOX_ID/messages -H "authorization: Bearer $KEY" | jq
```

## Deployment

### Option A — self-host SMTP (full control)

You need a Linux VPS, a domain you control, and outbound DNS access for MX.

1. **DNS**. Add an MX record for `mail.yourdomain.com` pointing at the VPS
   hostname. Optionally add an SPF TXT for outbound (we don't send mail, but
   some senders skip domains without one).

   ```
   mail.yourdomain.com.  IN  MX  10  vps.yourdomain.com.
   vps.yourdomain.com.   IN  A   1.2.3.4
   ```

2. **Open ports** 25 and 8080 (or 443 behind a reverse proxy).

3. **Run** with Docker Compose:

   ```bash
   cp .env.example .env  # set MAIL_DOMAIN=mail.yourdomain.com, set API_KEY
   docker compose up -d --build
   ```

4. **Verify** inbound delivery by sending yourself a test email:

   ```bash
   curl -X POST http://YOUR_HOST:8080/api/inboxes \
     -H "authorization: Bearer $API_KEY" \
     -H "content-type: application/json" -d '{}'
   # Then email that address from anywhere. Watch:
   docker compose logs -f
   ```

   Many cloud providers block outbound port 25 by default. If your test sender
   can't reach you, use option B.

5. **TLS for the HTTP API** is recommended. Put Caddy or nginx in front of
   port 8080 and terminate TLS there.

### Option B — Cloudflare Email Routing (no port 25 needed)

This is the easy path. Free for low volume and avoids ISPs that block port 25.

1. Add your domain to Cloudflare DNS and enable **Email Routing**.

2. Create an Email Worker with this code, replacing the URL and bearer token:

   ```js
   export default {
     async email(message, env) {
       const raw = await new Response(message.raw).arrayBuffer();
       await fetch("https://mail.yourdomain.com/api/incoming", {
         method: "POST",
         headers: {
           authorization: `Bearer ${env.MAIL_API_KEY}`,
           "content-type": "message/rfc822",
           "x-recipients": message.to
         },
         body: raw
       });
     }
   };
   ```

3. In Email Routing → **Catch-all address**, set the action to "Send to a
   Worker" and pick this worker. Now every `*@yourdomain.com` is forwarded.

4. Deploy the mail-server with `SMTP_PORT=` (empty) so it skips port 25 and
   serves only HTTP. The MCP server still talks to it the same way.

### Option C — Mailgun / Postmark inbound routes

Same idea as B: configure a route that POSTs the raw MIME to
`https://mail.yourdomain.com/api/incoming` with the bearer token header. Most
providers can forward the raw RFC822 body directly.

## Plugging it into the MCP server

The MCP server picks up two env vars:

```
SCRAPEFLOW_MAIL_API_URL=https://mail.yourdomain.com
SCRAPEFLOW_MAIL_API_KEY=...same API_KEY as on the mail-server...
```

See `../mcp-server/cursor.mcp.json.example` for a full Claude/Cursor config.

The new tools become available alongside the browser-automation ones:

- `create_temp_email` — returns `{ inbox_id, address }`.
- `get_temp_email_inbox` — list messages.
- `get_temp_email_message` — full body of one message.
- `wait_for_email` — long-poll (up to 120s) for new mail.
- `delete_temp_email` — clean up.

## Operational notes

- Every accepted message is fully parsed into `text` + `html`. If you need raw
  RFC822, change the ingest path to keep the buffer; skipped here to keep the
  SQLite file small.
- Inboxes expire after `DEFAULT_TTL_MS` (24h) and are swept every
  `CLEANUP_INTERVAL_MS` (15 min).
- The SMTP receiver only accepts mail addressed to `MAIL_DOMAIN` — it does
  not relay. Open relays on port 25 get abused immediately.
- There is no TLS on SMTP. That's fine for catch-all on a throwaway domain;
  most senders fall back to plaintext when STARTTLS isn't offered. If you
  care, terminate STARTTLS in Caddy/Postfix and forward locally.
