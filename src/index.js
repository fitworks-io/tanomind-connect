import { createHash, randomBytes } from "node:crypto";

const DEFAULT_ORIGIN = "https://tanomind.com";
const VALID_SCOPES = new Set(["read_profile", "send_task"]);

export class ConnectError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ConnectError";
    this.status = status;
    this.code = code;
  }
}

/** Server-side Tanomind Connect v1 client. Never bundle your app key into browser code. */
export class TanomindConnect {
  constructor({ appId, appKey, origin = DEFAULT_ORIGIN, fetchImpl = fetch }) {
    if (!appId || !appKey) throw new Error("appId and appKey are required");
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("HTTPS origin required");
    this.appId = appId;
    this.appKey = appKey;
    this.origin = url.origin;
    this.fetchImpl = fetchImpl;
  }

  async #request(path, { method = "GET", credential = this.appKey, body } = {}) {
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method,
      headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ConnectError(data.error || `Connect request failed (${response.status})`, response.status, data.code || null);
    return data;
  }

  /** Register the exact HTTPS callback once, from your server. */
  registerRedirect(redirectUri) {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" || url.hash || url.username || url.password || url.toString() !== redirectUri) throw new Error("Exact HTTPS redirect URI required");
    return this.#request("/api/connect/v1/redirects", { method: "POST", body: { redirect_uri: redirectUri } });
  }

  /** Save state and codeVerifier in the person's server-side session before redirecting. */
  authorization({ redirectUri, scopes = ["read_profile", "send_task"] }) {
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !VALID_SCOPES.has(scope))) throw new Error("Invalid Connect scopes");
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL("/connect/authorize", this.origin);
    url.search = new URLSearchParams({ app_id: this.appId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256", scope: scopes.join(" ") }).toString();
    return { url: url.toString(), state, codeVerifier };
  }

  /** Compare state to your stored one before calling this. Code is single-use. */
  exchangeCode({ code, redirectUri, codeVerifier }) {
    return this.#request("/api/connect/v1/token", { method: "POST", body: { code, redirect_uri: redirectUri, code_verifier: codeVerifier } });
  }

  refresh({ sessionId, sessionToken }) {
    return this.#request("/api/connect/v1/refresh", { method: "POST", body: { session_id: sessionId, session_token: sessionToken } });
  }

  profile(sessionToken) { return this.#request("/api/connect/v1/profile", { credential: sessionToken }); }

  createTask(sessionToken, { idempotencyKey, instructions, state = {}, ttlSeconds = 300 }) {
    return this.#request("/api/connect/v1/tasks", { method: "POST", credential: sessionToken, body: { idempotency_key: idempotencyKey, instructions, state, ttl_seconds: ttlSeconds } });
  }

  task(sessionToken, taskId) {
    return this.#request(`/api/connect/v1/tasks/${encodeURIComponent(taskId)}`, { credential: sessionToken });
  }

  cancelTask(sessionToken, taskId) {
    return this.#request(`/api/connect/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", credential: sessionToken });
  }

  /** Short, game-oriented turn. Use only for active sessions, not animation frames. */
  runTurn(sessionToken, { instructions, state }) {
    return this.#request("/api/connect/v1/run", { method: "POST", credential: sessionToken, body: { instructions, state } });
  }

  turn(sessionToken, turnId) {
    return this.#request(`/api/connect/v1/turn/${encodeURIComponent(turnId)}`, { credential: sessionToken });
  }

  revoke(sessionToken) {
    return this.#request("/api/connect/v1/revoke", { method: "POST", credential: sessionToken });
  }
}
