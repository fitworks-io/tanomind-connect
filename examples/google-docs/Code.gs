// Tanomind helper for Google Docs. Bound to a Doc, deployed as a web app for the Connect callback.
// Script properties: TANOME_APP_ID, TANOME_APP_KEY, REDIRECT_URI (the web app /exec URL).

var TANOME = "https://tanomind.com";
var MAX_TEXT = 6000;

var MODES = {
  proofread: {
    instructions: 'Proofread state.text. Fix spelling, grammar, and punctuation only. Keep the meaning, tone, and line breaks. Complete the task with {"type":"data","data":{"text":"<the full corrected text>"},"message":"<one line on what you changed>"}.',
    field: "text", max: MAX_TEXT * 2
  },
  summarize: {
    instructions: 'Summarize state.text in two or three plain sentences. Complete the task with {"type":"data","data":{"summary":"<the summary>"}}.',
    field: "summary", max: 1200
  },
  title: {
    instructions: 'Suggest one short title for state.text, at most 80 characters. Complete the task with {"type":"data","data":{"title":"<the title>"}}.',
    field: "title", max: 80
  }
};

function onOpen() {
  DocumentApp.getUi().createMenu("Tanomind").addItem("Open helper", "showSidebar").addToUi();
}

function showSidebar() {
  DocumentApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile("Sidebar").setTitle("Tanomind helper"));
}

function config_() {
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty("TANOME_APP_ID");
  var appKey = props.getProperty("TANOME_APP_KEY");
  var redirectUri = props.getProperty("REDIRECT_URI");
  if (!appId || !appKey || !/^https:\/\/script\.google\.com\/.+\/exec$/.test(redirectUri || "")) {
    throw new Error("Set TANOME_APP_ID, TANOME_APP_KEY and REDIRECT_URI in Project Settings > Script properties.");
  }
  return { appId: appId, appKey: appKey, redirectUri: redirectUri };
}

function call_(path, credential, method, body) {
  var options = { method: method || "get", headers: { Authorization: "Bearer " + credential }, muteHttpExceptions: true };
  if (body !== undefined) { options.contentType = "application/json"; options.payload = JSON.stringify(body); }
  var response = UrlFetchApp.fetch(TANOME + path, options);
  var data = {};
  try { data = JSON.parse(response.getContentText() || "{}"); } catch (e) {}
  if (response.getResponseCode() >= 400) throw new Error(data.error || "Tanomind request failed (" + response.getResponseCode() + ")");
  return data;
}

function randomString_() {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(Utilities.getUuid() + Utilities.getUuid()).getBytes()).replace(/=+$/, "");
}

// Run once from the editor after deploying the web app.
function registerCallback() {
  var config = config_();
  call_("/api/connect/v1/redirects", config.appKey, "post", { redirect_uri: config.redirectUri });
  Logger.log("Registered " + config.redirectUri);
}

function status() {
  var session = session_();
  return session ? { connected: true, handle: session.handle } : { connected: false };
}

function startConnect() {
  var config = config_();
  var state = randomString_();
  var verifier = randomString_() + randomString_();
  var challenge = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier, Utilities.Charset.US_ASCII)).replace(/=+$/, "");
  PropertiesService.getUserProperties().setProperty("tanome_attempt", JSON.stringify({ state: state, verifier: verifier, at: Date.now() }));
  var query = {
    app_id: config.appId, redirect_uri: config.redirectUri, state: state,
    code_challenge: challenge, code_challenge_method: "S256", scope: "read_profile send_task"
  };
  return TANOME + "/connect/authorize?" + Object.keys(query).map(function (key) {
    return key + "=" + encodeURIComponent(query[key]);
  }).join("&");
}

function doGet(e) {
  var props = PropertiesService.getUserProperties();
  var attempt = JSON.parse(props.getProperty("tanome_attempt") || "null");
  props.deleteProperty("tanome_attempt");
  var params = e.parameter || {};
  if (params.error) return page_("Connection was not approved. You can close this tab.");
  if (!attempt || Date.now() - attempt.at > 10 * 60 * 1000 || params.state !== attempt.state || !params.code) {
    return page_("This sign-in link is stale. Open the helper in your Doc and try again.");
  }
  var config = config_();
  var granted = call_("/api/connect/v1/token", config.appKey, "post", { code: params.code, redirect_uri: config.redirectUri, code_verifier: attempt.verifier });
  saveSession_({
    token: granted.session_token, id: granted.session_id,
    expiresAt: Date.now() + (granted.expires_in || 3600) * 1000,
    handle: (granted.agent && granted.agent.handle) || granted.agent_handle || "your agent"
  });
  return page_("Connected to @" + (granted.agent_handle || "your agent") + ". Close this tab and go back to your Doc.");
}

function page_(message) {
  var output = HtmlService.createHtmlOutput("<p style=\"font:16px system-ui;margin:40px\"></p>");
  output.append("<script>document.querySelector('p').textContent = " + JSON.stringify(message) + ";</script>");
  return output.setTitle("Tanomind");
}

function saveSession_(session) {
  PropertiesService.getUserProperties().setProperty("tanome_session", JSON.stringify(session));
}

function session_() {
  var session = JSON.parse(PropertiesService.getUserProperties().getProperty("tanome_session") || "null");
  if (!session) return null;
  if (Date.now() < session.expiresAt - 60 * 1000) return session;
  try {
    var next = call_("/api/connect/v1/refresh", config_().appKey, "post", { session_id: session.id, session_token: session.token });
    session.token = next.session_token;
    session.id = next.session_id || session.id;
    session.expiresAt = Date.now() + (next.expires_in || 3600) * 1000;
    saveSession_(session);
    return session;
  } catch (e) {
    PropertiesService.getUserProperties().deleteProperty("tanome_session");
    return null;
  }
}

function disconnect() {
  var session = session_();
  if (session) { try { call_("/api/connect/v1/revoke", session.token, "post"); } catch (e) {} }
  PropertiesService.getUserProperties().deleteProperty("tanome_session");
}

function sourceText_() {
  var doc = DocumentApp.getActiveDocument();
  var selection = doc.getSelection();
  if (selection) {
    var parts = selection.getRangeElements().map(function (range) {
      var element = range.getElement();
      if (!element.editAsText) return "";
      var text = element.asText().getText();
      return range.isPartial() ? text.substring(range.getStartOffset(), range.getEndOffsetInclusive() + 1) : text;
    }).filter(String);
    if (parts.length) return parts.join("\n");
  }
  return doc.getBody().getText();
}

function askAgent(mode) {
  var job = MODES[mode];
  if (!job) throw new Error("Unknown request.");
  var session = session_();
  if (!session) throw new Error("Connect an agent first.");
  var text = sourceText_();
  if (!text.trim()) throw new Error("The document is empty.");
  if (text.length > MAX_TEXT) throw new Error("Select up to " + MAX_TEXT + " characters.");
  var task = call_("/api/connect/v1/tasks", session.token, "post", {
    idempotency_key: "gdoc-" + mode + "-" + randomString_().slice(0, 16),
    instructions: job.instructions, state: { text: text }, ttl_seconds: 300
  });
  return task.task_id;
}

function checkTask(taskId, mode) {
  var job = MODES[mode];
  var session = session_();
  if (!job || !session || !/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error("Connect an agent first.");
  var task = call_("/api/connect/v1/tasks/" + taskId, session.token);
  var message = task.result && typeof task.result.message === "string" ? task.result.message.slice(0, 300) : null;
  if (task.status !== "completed") return { status: task.status, message: message };
  // Agent output is untrusted. Only the field each mode expects gets through.
  var value = task.result && task.result.data && task.result.data[job.field];
  if (typeof value !== "string" || !value.trim() || value.length > job.max) {
    return { status: "failed", message: "The agent's answer was not in the expected shape." };
  }
  return { status: "completed", value: value, message: message };
}

function insertText(value) {
  if (typeof value !== "string" || value.length > MAX_TEXT * 2) throw new Error("Nothing to insert.");
  var doc = DocumentApp.getActiveDocument();
  var cursor = doc.getCursor();
  if (cursor && cursor.insertText(value)) return;
  doc.getBody().appendParagraph(value);
}
