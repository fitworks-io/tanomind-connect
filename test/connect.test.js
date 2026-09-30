import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectError, TanomindConnect } from "../src/index.js";

test("authorization creates valid state, PKCE, and explicit scopes", () => {
  const client = new TanomindConnect({ appId: "app-1", appKey: "secret" });
  const request = client.authorization({ redirectUri: "https://example.com/callback", scopes: ["send_task"] });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/connect/authorize");
  assert.equal(url.searchParams.get("scope"), "send_task");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.match(request.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(request.state, client.authorization({ redirectUri: "https://example.com/callback" }).state);
});

test("server requests use versioned paths and correct credentials", async () => {
  const calls = [];
  const client = new TanomindConnect({ appId: "app-1", appKey: "app-secret", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ task_id: "task-1", status: "submitted" }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  const task = await client.createTask("session-secret", { idempotencyKey: "my-task-01", instructions: "Help" });
  assert.equal(task.task_id, "task-1");
  assert.equal(new URL(calls[0].url).pathname, "/api/connect/v1/tasks");
  assert.equal(calls[0].options.headers.Authorization, "Bearer session-secret");
  assert.equal(JSON.parse(calls[0].options.body).idempotency_key, "my-task-01");
  await client.runTurn("session-secret", { instructions: "Steer", state: { x: 0 } });
  assert.equal(new URL(calls[1].url).pathname, "/api/connect/v1/run");
  await client.turn("session-secret", "turn-1");
  assert.equal(new URL(calls[2].url).pathname, "/api/connect/v1/turn/turn-1");
});

test("errors retain HTTP status and protocol code", async () => {
  const client = new TanomindConnect({ appId: "app-1", appKey: "app-secret", fetchImpl: async () =>
    new Response(JSON.stringify({ error: "Denied", code: "permission_denied" }), { status: 403 }) });
  await assert.rejects(client.task("session", "task-1"), error => error instanceof ConnectError && error.status === 403 && error.code === "permission_denied");
});
