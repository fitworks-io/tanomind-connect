# Doc helper

A small writing page that works with your Tanomind agent. You write in a text box, connect your agent, and ask it to proofread, summarize, or suggest a title. Your agent does the work in its own loop. The page sends a Connect task, waits for the answer, checks its shape, and shows it.

It shows the full Connect flow in about 200 lines: sign-in with PKCE, a server-side session, tasks, polling, token refresh, and revoke. It needs only Node 20 or later and the kit in `../../src`.

## What you need

- A Tanomind app ID and control key. Create them in Tanomind Settings under Developers.
- An HTTPS address for this server. Connect only accepts exact HTTPS callbacks, so a plain `localhost` address will not work. For local testing, a tunnel is easiest:

```bash
cloudflared tunnel --url http://localhost:3000
```

This prints an address like `https://quiet-river-1234.trycloudflare.com`. Use it as `PUBLIC_URL`.

## Run it

PowerShell:

```powershell
$env:TANOME_APP_ID="your-app-id"
$env:TANOME_APP_KEY="your-control-key"
$env:PUBLIC_URL="https://quiet-river-1234.trycloudflare.com"
node server.js --register
node server.js
```

macOS or Linux:

```bash
export TANOME_APP_ID=your-app-id TANOME_APP_KEY=your-control-key PUBLIC_URL=https://quiet-river-1234.trycloudflare.com
node server.js --register
node server.js
```

`--register` adds `PUBLIC_URL/connect/callback` to your app once. Run it again if the tunnel address changes.

Open `PUBLIC_URL` in a browser, click Connect a Tanomind agent, approve, and write something.

## How the agent sees it

Each button creates a task with short instructions and the document text in `state.text`. The agent picks it up from `GET /api/agent/connect-tasks` and replies with `POST /api/agent/connect-tasks/{id}/update`. Proofread, for example, expects:

```json
{ "status": "completed", "result": { "type": "data", "data": { "text": "the corrected text" }, "message": "Fixed two typos." } }
```

If the answer is missing a field or is too long, the page shows an error and leaves your document alone.

## Before you ship something like this

- Keep `TANOME_APP_KEY` and session tokens on the server. The browser only gets an HttpOnly cookie.
- Sessions here live in memory and disappear on restart. Use a real session store.
- Treat agent output as untrusted input. This example only accepts the fields each button expects and renders them as text.

## Google Docs

The same flow fits a Google Docs add-on. An Apps Script sidebar would call a server like this one, send the selected text as `state.text`, and write the result back with `DocumentApp`. The Connect part does not change.
