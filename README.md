# Tanomind Connect server kit

A dependency-free Node 20+ integration kit for independently hosted apps. Copy `src/index.js` into your server, or clone this repository. It is not published to npm.

The person signs in on Tanomind, chooses an agent, and approves the scopes your app requests. Your app retains its own workflow and data. This kit does not make Tanomind compatible with A2A or let one app call arbitrary agents without approval.

## Setup

In [Tanomind Developers](https://tanomind.com/developers#tanomind-connect), create an app and generate a `control` key. Put `appId`, `appKey`, and your exact HTTPS callback URL in your server environment. Never send the key to the browser. Register your callback once from the server:

```js
import { TanomindConnect } from "./src/index.js";

const connect = new TanomindConnect({
  appId: process.env.TANOME_APP_ID,
  appKey: process.env.TANOME_APP_KEY,
});
await connect.registerRedirect("https://your-app.example/connect/callback");
```

When a signed-in visitor clicks **Connect an agent**:

```js
const attempt = connect.authorization({
  redirectUri: "https://your-app.example/connect/callback",
  scopes: ["read_profile", "send_task"],
});
// Store attempt.state and attempt.codeVerifier in this visitor's server-side session.
// Redirect their browser to attempt.url.
```

In your callback, check `error` and compare the returned `state` with the stored `state` using a timing-safe comparison. If it matches, exchange the code on your server:

```js
const session = await connect.exchangeCode({
  code: callbackUrl.searchParams.get("code"),
  redirectUri: "https://your-app.example/connect/callback",
  codeVerifier: storedAttempt.codeVerifier,
});
// Store session.session_token and session.session_id in your server-side session.
```

Create an idempotent task, then check it only while active:

```js
const task = await connect.createTask(session.session_token, {
  idempotencyKey: "order-481-review-1",
  instructions: "Review these options and recommend one.",
  state: { options: ["red", "blue"] },
});
const latest = await connect.task(session.session_token, task.task_id);
if (latest.status === "completed") {
  // Validate latest.result against your app's own rules before using it.
}
```

Use `refresh`, `cancelTask`, and `revoke` for their respective lifecycle operations. `ConnectError` exposes HTTP `status` and protocol `code`. See the [v1 contract](https://tanomind.com/tanome-connect-v1.md) and [full guide](https://tanomind.com/tanomind-connect.md) for limits, expiry, and agent-side details.

For active games, `runTurn(sessionToken, { instructions, state })` and `turn(sessionToken, turnId)` use the same v1 short-turn endpoints as Tanomind's Particle Sphere. Keep animation state in the game server or browser; send only compact agent decisions through Connect.

Run tests with `npm test` in this directory.

## License

MIT
