import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TanomindConnect, ConnectError } from "../../src/index.js";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3000);
if (!PUBLIC_URL.startsWith("https://")) throw new Error("Set PUBLIC_URL to the HTTPS address of this server, for example a cloudflared tunnel.");
const REDIRECT_URI = `${PUBLIC_URL}/connect/callback`;
const MAX_TEXT = 6000;

const connect = new TanomindConnect({ appId: process.env.TANOME_APP_ID, appKey: process.env.TANOME_APP_KEY, origin: process.env.TANOME_ORIGIN });

if (process.argv.includes("--register")) {
  await connect.registerRedirect(REDIRECT_URI);
  console.log(`Registered ${REDIRECT_URI}`);
  process.exit(0);
}

const MODES = {
  proofread: {
    label: "Proofread",
    instructions: 'Proofread state.text. Fix spelling, grammar, and punctuation only. Keep the meaning, tone, and line breaks. Complete the task with {"type":"data","data":{"text":"<the full corrected text>"},"message":"<one line on what you changed>"}.',
    read: (data) => typeof data?.text === "string" && data.text.length <= MAX_TEXT * 2 ? { text: data.text } : null,
  },
  summarize: {
    label: "Summarize",
    instructions: 'Summarize state.text in two or three plain sentences. Complete the task with {"type":"data","data":{"summary":"<the summary>"}}.',
    read: (data) => typeof data?.summary === "string" && data.summary.length <= 1200 ? { summary: data.summary } : null,
  },
  title: {
    label: "Suggest a title",
    instructions: 'Suggest one short title for state.text, at most 80 characters. Complete the task with {"type":"data","data":{"title":"<the title>"}}.',
    read: (data) => typeof data?.title === "string" && data.title.length <= 80 ? { title: data.title } : null,
  },
};

// Demo only: sessions live in memory and vanish on restart. Use a real session store in production.
const sessions = new Map();

function sessionFor(req, res) {
  const id = /(?:^|;\s*)sid=([A-Za-z0-9_-]{32})/.exec(req.headers.cookie ?? "")?.[1];
  if (id && sessions.has(id)) return sessions.get(id);
  const fresh = randomBytes(24).toString("base64url");
  const session = { id: fresh };
  sessions.set(fresh, session);
  res.setHeader("Set-Cookie", `sid=${fresh}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`);
  return session;
}

function sameText(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

async function liveToken(session) {
  const tanome = session.tanome;
  if (!tanome) return null;
  if (Date.now() < tanome.expiresAt - 60_000) return tanome.token;
  const next = await connect.refresh({ sessionId: tanome.sessionId, sessionToken: tanome.token });
  session.tanome = { ...tanome, token: next.session_token, sessionId: next.session_id ?? tanome.sessionId, expiresAt: Date.now() + (next.expires_in ?? 3600) * 1000 };
  return session.tanome.token;
}

async function route(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const session = sessionFor(req, res);

  if (req.method === "GET" && url.pathname === "/") return send(res, 200, page(session), "text/html; charset=utf-8");

  if (req.method === "GET" && url.pathname === "/connect") {
    const attempt = connect.authorization({ redirectUri: REDIRECT_URI, scopes: ["read_profile", "send_task"] });
    session.attempt = { state: attempt.state, codeVerifier: attempt.codeVerifier };
    res.writeHead(302, { Location: attempt.url });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/connect/callback") {
    const attempt = session.attempt;
    session.attempt = null;
    if (url.searchParams.get("error")) return send(res, 400, "Connection was not approved. <a href=\"/\">Back</a>", "text/html; charset=utf-8");
    if (!attempt || !sameText(url.searchParams.get("state"), attempt.state)) return send(res, 400, "This sign-in link is stale. <a href=\"/\">Try again</a>", "text/html; charset=utf-8");
    const granted = await connect.exchangeCode({ code: url.searchParams.get("code"), redirectUri: REDIRECT_URI, codeVerifier: attempt.codeVerifier });
    session.tanome = { token: granted.session_token, sessionId: granted.session_id, expiresAt: Date.now() + (granted.expires_in ?? 3600) * 1000, agent: granted.agent ?? { handle: granted.agent_handle } };
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/disconnect") {
    const token = await liveToken(session).catch(() => null);
    if (token) await connect.revoke(token).catch(() => {});
    session.tanome = null;
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    const token = await liveToken(session);
    if (!token) return send(res, 401, { error: "Connect an agent first." });
    const { mode, text } = await readJson(req);
    const job = MODES[mode];
    if (!job) return send(res, 400, { error: "Unknown request." });
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return send(res, 400, { error: `Write between 1 and ${MAX_TEXT} characters.` });
    const task = await connect.createTask(token, { idempotencyKey: `doc-${mode}-${randomBytes(9).toString("base64url")}`, instructions: job.instructions, state: { text }, ttlSeconds: 300 });
    return send(res, 200, { task_id: task.task_id, status: task.status });
  }

  const taskMatch = /^\/api\/task\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
  if (req.method === "GET" && taskMatch) {
    const token = await liveToken(session);
    if (!token) return send(res, 401, { error: "Connect an agent first." });
    const mode = url.searchParams.get("mode");
    const task = await connect.task(token, taskMatch[1]);
    if (task.status !== "completed") return send(res, 200, { status: task.status, message: task.result?.message ?? null });
    // Agent output is untrusted. Only the fields each mode expects get through.
    const result = MODES[mode]?.read(task.result?.data);
    if (!result) return send(res, 200, { status: "failed", message: "The agent's answer was not in the expected shape." });
    return send(res, 200, { status: "completed", result, message: typeof task.result?.message === "string" ? task.result.message.slice(0, 300) : null });
  }

  send(res, 404, { error: "Not found" });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error instanceof ConnectError ? error.status : 500;
    if (!res.headersSent) send(res, status >= 400 && status < 600 ? status : 500, { error: error.message });
  });
}).listen(PORT, () => console.log(`Doc helper on http://localhost:${PORT} (public ${PUBLIC_URL})`));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function page(session) {
  const agent = session.tanome?.agent;
  const buttons = Object.entries(MODES).map(([id, mode]) => `<button data-mode="${id}" ${agent ? "" : "disabled"}>${mode.label}</button>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Doc helper</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #111; background: #fafafa; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  textarea { width: 100%; min-height: 320px; padding: 16px; font: inherit; border: 1px solid #ccc; border-radius: 8px; background: #fff; box-sizing: border-box; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  button, .connect { padding: 8px 14px; border-radius: 8px; border: 1px solid #111; background: #111; color: #fff; font: inherit; cursor: pointer; text-decoration: none; }
  button[disabled] { opacity: .4; cursor: not-allowed; }
  .ghost { background: #fff; color: #111; }
  #status { min-height: 1.5em; }
  #result { white-space: pre-wrap; background: #fff; border: 1px solid #ccc; border-radius: 8px; padding: 12px 16px; }
  #result:empty { display: none; }
  .error { color: #c00; }
</style>
</head>
<body>
<header>
  <h1>Doc helper</h1>
  ${agent
    ? `<span>Agent: <strong>@${escapeHtml(agent.handle)}</strong> <button class="ghost" id="disconnect">Disconnect</button></span>`
    : `<a class="connect" href="/connect">Connect a Tanomind agent</a>`}
</header>
<p>Write below, then ask your agent for help. Your agent does the work. This page only checks the answer and shows it.</p>
<textarea id="doc" maxlength="${MAX_TEXT}" placeholder="Start writing..."></textarea>
<div class="row">${buttons}</div>
<p id="status"></p>
<div id="result"></div>
<script>
  const doc = document.getElementById("doc");
  const status = document.getElementById("status");
  const result = document.getElementById("result");
  doc.value = localStorage.getItem("doc") ?? "";
  doc.addEventListener("input", () => localStorage.setItem("doc", doc.value));
  document.getElementById("disconnect")?.addEventListener("click", async () => { await fetch("/disconnect", { method: "POST" }); location.reload(); });
  const say = (text, isError) => { status.textContent = text; status.className = isError ? "error" : ""; };
  const buttons = [...document.querySelectorAll("[data-mode]")];

  for (const button of buttons) button.addEventListener("click", async () => {
    const mode = button.dataset.mode;
    buttons.forEach((b) => b.disabled = true);
    result.textContent = "";
    say("Sending to your agent...");
    try {
      const started = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, text: doc.value }) }).then((r) => r.json());
      if (!started.task_id) throw new Error(started.error ?? "Could not send the task.");
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const task = await fetch("/api/task/" + started.task_id + "?mode=" + mode).then((r) => r.json());
        if (task.status === "completed") {
          if (mode === "proofread") { doc.value = task.result.text; localStorage.setItem("doc", doc.value); say(task.message ?? "Proofread done."); }
          else { result.textContent = task.result.summary ?? task.result.title; say("Done."); }
          break;
        }
        if (task.status === "input-required") say("Your agent has a question. Answer it in Tanomind Settings under Connected apps.");
        else if (["failed", "canceled", "expired"].includes(task.status)) throw new Error(task.message ?? "The task " + task.status + ".");
        else if (task.error) throw new Error(task.error);
        else say("Your agent is working on it...");
      }
    } catch (error) {
      say(error.message, true);
    } finally {
      buttons.forEach((b) => b.disabled = false);
    }
  });
</script>
</body>
</html>`;
}
