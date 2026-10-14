// Infocom Library front end: sign-in, the library grid, and the player.
// Talks to the JSON API in server/serve.py. No framework, no build step.
"use strict";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const GENRE_HUES = {
  Fantasy: "#c9893a", "Science fiction": "#4f9fc4", Mystery: "#9a6fc4", Adventure: "#5aa86d",
  Comedy: "#d4b13a", Horror: "#b8473a", Romance: "#cc6a8f", Junior: "#6fbfb0",
  Historical: "#a58a5c", Wordplay: "#8aa83d", Espionage: "#7f8b99",
};
const INTERCEPTED = /^\s*(save|restore|undo)\s*$/i;

const state = { user: null, signup: false, games: [], game: null, history: [], histPos: 0, busy: false };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch("/api/" + path, opts);
  let data = {};
  try { data = await r.json(); } catch { /* empty or not JSON */ }
  if (r.status === 401 && path !== "login") {
    state.user = null;
    showAuth();
  }
  if (!r.ok) throw new HttpError(r.status, data.error || `request failed (${r.status})`);
  return data;
}

function show(id) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
  $("#who").hidden = !state.user;
  $("#who-name").textContent = state.user || "";
}

// --- sign in ----------------------------------------------------------------

let creating = false;

function showAuth() {
  show("view-auth");
  $("#auth-toggle").hidden = !state.signup;
  setAuthMode(creating && state.signup);
  $("#auth-form").username.focus();
}

function setAuthMode(create) {
  creating = create;
  $("#auth-submit").textContent = create ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = create ? "I have an account" : "Create an account";
  $("#auth-form").password.autocomplete = create ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
}

$("#auth-toggle").addEventListener("click", () => setAuthMode(!creating));
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("#auth-error").textContent = "";
  try {
    const r = await api("POST", creating ? "signup" : "login",
      { username: f.username.value.trim(), password: f.password.value });
    state.user = r.user;
    f.password.value = "";
    route();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  }
});

$("#btn-logout").addEventListener("click", async () => {
  await api("POST", "logout", {}).catch(() => {});
  state.user = null;
  location.hash = "#/";
  init();
});

$("#btn-password").addEventListener("click", () => {
  const f = $("#password-form");
  f.reset();
  f.username.value = state.user;
  $("#password-error").textContent = "";
  $("#dlg-password").showModal();
});
$("#password-ok").addEventListener("click", async (e) => {
  const f = $("#password-form");
  if (!f.reportValidity()) return;
  e.preventDefault();
  try {
    await api("POST", "password", { current: f.current.value, new: f.new.value });
    $("#dlg-password").close();
  } catch (err) {
    $("#password-error").textContent = err.message;
  }
});

// --- library ----------------------------------------------------------------

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} hours ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function card(g) {
  const a = el("a", "card");
  a.href = `#/play/${g.id}`;
  a.style.setProperty("--genre", GENRE_HUES[g.genre] || "var(--faint)");
  const meta = [g.year, g.genre, g.version ? `z${g.version}` : null].filter(Boolean).join(" · ");
  a.append(el("span", "meta", meta), el("h3", null, g.title));
  if (g.subtitle) a.append(el("span", "sub", g.subtitle));
  if (g.progress) {
    const where = (g.progress.status || "").split("\t")[0].trim();
    const what = g.progress.ended ? "Finished" : `${g.progress.moves} moves${where ? " · " + where : ""}`;
    a.append(el("span", "prog", `${what} · ${ago(g.progress.updated)}`));
  }
  if (g.blurb) a.append(el("p", "blurb", g.blurb));
  if (g.notes) a.append(el("span", "note", g.notes));
  const rel = g.release ? `Release ${g.release}${g.serial ? " / " + g.serial : ""}` : g.file;
  a.append(el("span", "by", [g.authors, rel].filter(Boolean).join(" — ")));
  return a;
}

function renderLibrary() {
  const q = $("#filter").value.trim().toLowerCase();
  const match = (g) => !q || [g.title, g.subtitle, g.authors, g.genre, g.file]
    .some((v) => v && String(v).toLowerCase().includes(q));
  const games = state.games.filter(match);
  const playing = games.filter((g) => g.progress && g.progress.moves > 0)
    .sort((a, b) => b.progress.updated - a.progress.updated);
  $("#grid-continue").replaceChildren(...playing.slice(0, 6).map(card));
  $("#continue").hidden = !playing.length;
  $("#all-head").hidden = !playing.length;
  $("#grid").replaceChildren(...games.map(card));
  $("#empty").hidden = state.games.length > 0;
  const n = state.games.length;
  $("#library-count").textContent = n ? `${n} ${n === 1 ? "story" : "stories"} on the shelf.` : "";
}

$("#filter").addEventListener("input", renderLibrary);

async function showLibrary() {
  show("view-library");
  const r = await api("GET", "games");
  state.games = r.games;
  renderLibrary();
}

// --- playing ----------------------------------------------------------------

const screen = $("#screen");
const transcript = $("#transcript");
const cmdInput = $("#cmd");

function turnNode(t) {
  const d = el("div", "turn");
  if (t.cmd != null) {
    const c = el("div", "cmd");
    c.append(el("span", "p", t.prompt || ">"), document.createTextNode(t.cmd === "" ? "" : t.cmd));
    d.append(c);
  }
  d.append(document.createTextNode(t.text));
  return d;
}

function setStatus(status) {
  const [left, right] = (status || "").split("\t");
  $("#status-left").textContent = (left || "").trim();
  $("#status-right").textContent = (right || "").replace(/\s{2,}/g, "  ").trim();
}

function applyView(v) {
  state.game = v.game;
  document.title = `${v.game.title} — Infocom Library`;
  $("#play-title").textContent = v.game.title;
  const nodes = v.turns.map(turnNode);
  if (v.hidden) nodes.unshift(el("div", "hidden-note", `(${v.hidden} earlier moves not shown)`));
  transcript.replaceChildren(...nodes);
  setPlayState(v);
  screen.scrollTop = screen.scrollHeight;
}

function setPlayState(v) {
  setStatus(v.status);
  $("#prompt").textContent = v.prompt || ">";
  $("#ended").hidden = !v.ended;
  $("#input-form").hidden = !!v.ended;
  $("#btn-undo").disabled = !v.canUndo;
  if (!v.ended) cmdInput.focus({ preventScroll: true });
}

async function showGame(id) {
  show("view-play");
  transcript.replaceChildren(el("div", "hidden-note", "Opening the story…"));
  $("#play-title").textContent = state.games.find((g) => g.id === id)?.title || "";
  setStatus("");
  state.history = [];
  state.histPos = 0;
  try {
    applyView(await api("GET", `games/${id}`));
  } catch (err) {
    if (err.status !== 401) transcript.replaceChildren(el("div", "hidden-note", err.message));
  }
}

async function busy(fn) {
  if (state.busy) return;
  state.busy = true;
  screen.classList.add("busy");
  try { return await fn(); } finally {
    state.busy = false;
    screen.classList.remove("busy");
  }
}

function scrollToTurn(node) {
  // A long reply starts at the top of the screen; a short one just scrolls to the bottom.
  if (node.offsetHeight > screen.clientHeight * 0.7) {
    screen.scrollTop = node.offsetTop - screen.offsetTop - 12;
  } else {
    screen.scrollTop = screen.scrollHeight;
  }
}

$("#input-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = cmdInput.value;
  if (INTERCEPTED.test(text)) {
    cmdInput.value = "";
    const verb = text.trim().toLowerCase();
    if (verb === "undo") undo();
    else openSaves(verb === "save");
    return;
  }
  busy(async () => {
    const prompt = $("#prompt").textContent;
    try {
      const r = await api("POST", `games/${state.game.id}/command`, { command: text });
      if (text.trim()) state.history.push(text);
      state.histPos = state.history.length;
      cmdInput.value = "";
      const node = turnNode({ prompt, cmd: r.turn.cmd, text: r.turn.text });
      transcript.append(node);
      setPlayState(r);
      scrollToTurn(node);
    } catch (err) {
      if (err.status !== 401) transcript.append(turnNode({ cmd: null, text: `[${err.message}]\n` }));
    }
  });
});

cmdInput.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const h = state.history;
  if (!h.length) return;
  e.preventDefault();
  state.histPos = Math.max(0, Math.min(h.length, state.histPos + (e.key === "ArrowUp" ? -1 : 1)));
  cmdInput.value = h[state.histPos] ?? "";
});

// Clicking anywhere on the screen (but not selecting text) focuses the input.
screen.addEventListener("click", () => {
  if (!window.getSelection().toString() && !$("#input-form").hidden) cmdInput.focus({ preventScroll: true });
});

async function undo() {
  await busy(async () => {
    try { applyView(await api("POST", `games/${state.game.id}/undo`, {})); } catch (err) { /* nothing to undo */ }
  });
}
$("#btn-undo").addEventListener("click", undo);
$("#ended-undo").addEventListener("click", undo);

function confirmDialog(title, text, ok) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  const d = $("#dlg-confirm");
  d.returnValue = "";
  d.showModal();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

async function restart(ask) {
  if (ask && !(await confirmDialog("Restart this story?",
    "Your current progress is replaced by a fresh start. Make a save first if you want to come back to it.",
    "Restart"))) return;
  await busy(async () => applyView(await api("POST", `games/${state.game.id}/restart`, {})));
}
$("#btn-restart").addEventListener("click", () => restart(true));
$("#ended-restart").addEventListener("click", () => restart(false));

// --- saves ------------------------------------------------------------------

function renderSaves(saves) {
  const list = $("#saves-list");
  if (!saves.length) {
    list.replaceChildren(el("li", "none", "No saves yet."));
    return;
  }
  list.replaceChildren(...saves.map((s) => {
    const li = el("li");
    const info = el("div", "info");
    info.append(el("div", "name", s.name), el("div", "when", `${s.moves} moves · ${ago(s.created)}`));
    const restore = el("button", "primary", "Restore");
    restore.type = "button";
    restore.addEventListener("click", async () => {
      try {
        const v = await busy(() => api("POST", `games/${state.game.id}/saves/${s.id}/restore`, {}));
        if (v) applyView(v);
        $("#dlg-saves").close();
      } catch (err) { $("#saves-error").textContent = err.message; }
    });
    const del = el("button", "link", "Delete");
    del.type = "button";
    del.addEventListener("click", async () => {
      try { renderSaves((await api("DELETE", `games/${state.game.id}/saves/${s.id}`)).saves); } catch (err) {
        $("#saves-error").textContent = err.message;
      }
    });
    li.append(info, restore, del);
    return li;
  }));
}

async function openSaves(focusSave) {
  $("#saves-error").textContent = "";
  $("#save-name").value = "";
  $("#saves-list").replaceChildren();
  $("#dlg-saves").showModal();
  if (focusSave) $("#save-name").focus();
  try { renderSaves((await api("GET", `games/${state.game.id}/saves`)).saves); } catch (err) {
    $("#saves-error").textContent = err.message;
  }
}
$("#btn-saves").addEventListener("click", () => openSaves(false));
$("#ended-restore").addEventListener("click", () => openSaves(false));
$("#btn-save").addEventListener("click", async () => {
  try {
    renderSaves((await api("POST", `games/${state.game.id}/saves`, { name: $("#save-name").value })).saves);
    $("#save-name").value = "";
  } catch (err) { $("#saves-error").textContent = err.message; }
});
$("#save-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("#btn-save").click(); }
});
$("#dlg-saves").addEventListener("close", () => {
  if (!$("#view-play").hidden && !$("#input-form").hidden) cmdInput.focus({ preventScroll: true });
});

// --- routing ----------------------------------------------------------------

function route() {
  if (!state.user) return showAuth();
  const m = location.hash.match(/^#\/play\/([0-9a-f]+)$/);
  if (m) return showGame(m[1]);
  document.title = "Infocom Library";
  showLibrary().catch(() => {});
}

window.addEventListener("hashchange", route);

async function init() {
  try {
    const me = await api("GET", "me");
    state.user = me.user;
    state.signup = me.signup;
  } catch {
    state.user = null;
  }
  route();
}

init();
