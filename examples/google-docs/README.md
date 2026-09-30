# Tanomind helper for Google Docs

A sidebar in Google Docs that sends your writing to your Tanomind agent. Select some text, or none for the whole Doc, then click Proofread, Summarize, or Suggest a title. Your agent does the work. The sidebar checks the answer and lets you insert it at the cursor.

It runs entirely in Google Apps Script. You don't need your own server, because the Apps Script web app URL is the HTTPS callback Connect needs.

## Set it up

1. In Tanomind Settings under Developers, create an app and a control key.
2. Open a Google Doc, then Extensions > Apps Script.
3. Paste `Code.gs` and add an HTML file named `Sidebar` with the contents of `Sidebar.html`. In Project Settings, turn on "Show appsscript.json" and replace it with `appsscript.json`.
4. Deploy > New deployment > Web app. Execute as "User accessing the web app", access "Anyone with a Google account". Copy the URL that ends in `/exec`.
5. In Project Settings > Script properties, add `TANOME_APP_ID`, `TANOME_APP_KEY`, and `REDIRECT_URI` (the `/exec` URL).
6. In the editor, run `registerCallback` once and approve the Google permissions.
7. Reload the Doc. Open Tanomind > Open helper, click Connect, approve in the new tab, then click "I approved it".

If you make a new deployment, the `/exec` URL changes. Update `REDIRECT_URI` and run `registerCallback` again. Editing an existing deployment keeps the URL.

## How it works

- Connect runs a PKCE sign-in. The state and verifier live in the user's own Apps Script properties, and the web app `doGet` checks them before it exchanges the code.
- Session tokens are kept in user properties, one set per Google account, and refreshed before they expire.
- Each button creates a Connect task with the text in `state.text`. The agent picks it up from `GET /api/agent/connect-tasks` and replies, for example:

```json
{ "status": "completed", "result": { "type": "data", "data": { "summary": "Two or three sentences." } } }
```

- The sidebar polls every 3 seconds. Only the field each button expects (`text`, `summary`, or `title`) gets through, with a length limit. Anything else shows an error.

## Limits of this example

- Anyone who can edit the script can read the script properties, including the control key. Keep the script private, or move the key to a small server and call it from Apps Script.
- Insert at cursor adds plain text. It doesn't replace the selection or keep formatting.
- To share it beyond your own Docs, publish it as a Workspace add-on. The Connect code stays the same.
