// PDF Prep for Project Library: the page. Gets PDFs (SharePoint links downloaded by the browser, or dropped files and
// folders), reads number and revision (register or NUMBER_REV.pdf), makes light reading copies in a background worker
// (prep-worker.js), packs them into batches under a size limit, then gives one zip and/or pushes to GitHub in one commit.
const REPO = "bijankle/ProjectLibrary";
const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const GH_MAX = 95e6;                                       // GitHub refuses files over 100 MB; keep a margin
const NUM = /^[A-Z0-9][A-Z0-9-]{4,60}$/, REV = /^[A-Z0-9]{1,4}$/;   // what the ingest script accepts (tools/ingest_uploads.py)
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mb = b => { const v = (b || 0) / 1e6; return (v < 0.1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toString()) + " MB"; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// ---------- small storage helpers (storage can be blocked: everything still works without it) ----------
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};
const DEF = { quality: 0.5, dpi: 110, limitMB: 25, keepText: true, branch: "main" };
let set = { ...DEF };
try { set = { ...DEF, ...JSON.parse(LS.get("pdfprep.settings") || "{}") }; } catch (_) {}
let token = LS.get("pdfprep.ghToken") || "";
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("pdfprep", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (_) { return null; } },
  async put(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); return true; } catch (_) { return false; } },
  async del(k) { try { const db = await this.open(); await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = res; t.onerror = res; }); } catch (_) {} },
};

// ---------- state ----------
const S = { docs: [], links: [], reg: null, batches: null, batchKey: "", batchesSent: "", busy: false, cancel: false, abort: null, blobShas: new Map() };
let nextId = 1;
class Cancelled extends Error { constructor() { super("Cancelled"); this.cancelled = true; } }

function msg(id, text, kind = "info") { const el = $(id); el.className = "msg" + (text ? " show " + kind : ""); el.textContent = text || ""; }

// revision order as the app and ingest script use it: letters (issues before Rev 0) < numbers, 1A after 1
function rk(r) { r = String(r || "").toUpperCase(); const m = /^(\d+)([A-Z]?)$/.exec(r); return m ? [1, +m[1], m[2]] : /^[A-Z]{1,2}$/.test(r) ? [0, r.length, r] : [0, 0, r]; }
const rkCmp = (a, b) => { const x = rk(a), y = rk(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

// ---------- file names ----------
const fileKey = name => String(name || "").split("/").pop().toLowerCase().replace(/\s\(\d+\)(\.\w+)$/, "$1");   // "a (1).pdf" from a repeated download = "a.pdf"
function parseName(name) {
  const b = String(name).split("/").pop().replace(/\.pdf$/i, "").replace(/\s\(\d+\)$/, "").trim();
  const m = /^(.+)_([A-Za-z0-9]{1,4})$/.exec(b) || /^(.+?)_([A-Za-z0-9]{1,4})_.+$/.exec(b);
  return m ? { number: m[1].trim().toUpperCase(), rev: m[2].toUpperCase() } : { number: b.toUpperCase(), rev: "" };
}
const libOk = d => NUM.test(d.number) && REV.test(d.rev);

// ---------- register ----------
function indexRegister(data) {
  const byFile = new Map(), byNum = new Map();
  for (const r of data.rows) {
    if (r[4]) byFile.set(fileKey(r[4]), r);
    const n = String(r[0] || "").trim().toUpperCase();
    if (n) { if (!byNum.has(n)) byNum.set(n, []); byNum.get(n).push(r); }
  }
  S.reg = { ...data, byFile, byNum };
}
function regLatest(num) {
  const rows = S.reg && S.reg.byNum.get(String(num).trim().toUpperCase());
  if (!rows || !rows.length) return null;
  const pdfs = rows.filter(r => /\.pdf$/i.test(r[4] || ""));
  return (pdfs.length ? pdfs : rows).slice().sort((a, b) => rkCmp(a[1], b[1])).pop();
}
function regFor(d) {
  if (!S.reg) return null;
  const byName = S.reg.byFile.get(fileKey(d.name));
  if (byName) return byName;
  const rows = S.reg.byNum.get(d.number);
  return rows ? rows.find(r => String(r[1]).toUpperCase() === d.rev) || null : null;
}
function applyRegister(d) {   // fills number, rev and title from the register unless typed by hand
  const r = regFor(d);
  if (!r) return;
  const n = String(r[0] || "").trim().toUpperCase(), v = String(r[1] || "").trim().toUpperCase();
  if (!d.edited.number && !d.edited.rev && NUM.test(n) && REV.test(v)) { d.number = n; d.rev = v; }
  if (!d.edited.title && r[2]) { d.title = r[2]; d.titleSrc = "register"; }
}
function regStatus() {
  const el = $("regStatus");
  if (!S.reg) { $("regForget").classList.add("hide"); return; }
  el.textContent = `Register loaded: ${S.reg.rows.length.toLocaleString()} rows from ${S.reg.name} (${new Date(S.reg.when).toLocaleDateString()}). Saved in this browser only.`;
  $("regForget").classList.remove("hide");
}
async function loadRegister(file) {
  $("regStatus").textContent = `Reading ${file.name}, this takes a few seconds...`;
  const w = new Worker("register-worker.js");
  try {
    const out = await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => { e.preventDefault(); rej(new Error("The register reader could not start. Check the internet connection and reload the page.")); }; w.postMessage({ file }); });
    if (!out.ok) throw new Error(out.error);
    const data = { name: file.name, when: Date.now(), rows: out.rows };
    indexRegister(data);
    const saved = await idb.put("register", data);
    regStatus();
    if (!saved) $("regStatus").textContent += " (This browser would not save it, so load it again next time.)";
    for (const d of S.docs) applyRegister(d);
    renderTable(); refreshLinks();
  } catch (e) {
    $("regStatus").textContent = "Could not read the register: " + e.message;
  } finally { w.terminate(); }
}

// ---------- SharePoint links ----------
const sitePrefix = p => (/^\/(sites|teams)\/[^/]+/i.exec(p) || [""])[0];
const safeDecode = s => { try { return decodeURIComponent(s); } catch (_) { return s; } };
function direct(origin, path) {   // a file's own address → SharePoint's download page for it (works for any library)
  return { url: `${origin}${sitePrefix(path)}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(path)}`, open: origin + encodeURI(path), file: path.split("/").pop() };
}
function linkInfo(line) {
  if (/^https?:\/\//i.test(line)) {
    let u; try { u = new URL(line); } catch (_) { return { bad: "This is not a complete web address." }; }
    if (!/sharepoint\.com$/i.test(u.hostname)) return { url: line, open: line, file: "", note: "Not a SharePoint address: it will be opened as it is." };
    const sm = /^\/:([a-z]):\/([a-z])\/(.*)$/i.exec(u.pathname);
    if (sm && sm[2].toLowerCase() === "r") return direct(u.origin, safeDecode("/" + sm[3]));   // "copy link" with the path inside
    if (sm) { const dl = new URL(line); dl.searchParams.set("download", "1"); return { url: dl.href, open: line, file: "" }; }   // a sharing link
    if (/\/_layouts\/15\/(Doc|WopiFrame\d*|download)\.aspx$/i.test(u.pathname)) {
      const id = (u.searchParams.get("sourcedoc") || u.searchParams.get("UniqueId") || "").replace(/[{}]/g, "");
      const src = u.searchParams.get("SourceUrl");
      if (src) return direct(u.origin, src.startsWith("http") ? new URL(src).pathname : src);
      if (id) return { url: `${u.origin}${sitePrefix(u.pathname)}/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(id)}`, open: line, file: u.searchParams.get("file") || "" };
      return { bad: "This SharePoint page link has no file in it." };
    }
    return direct(u.origin, safeDecode(u.pathname));
  }
  if (!S.reg) return { bad: "Not a link. Load the register to look up document numbers." };
  const r = S.reg.byFile.get(fileKey(line)) || S.reg.byFile.get(fileKey(line + ".pdf")) || regLatest(line);
  if (!r) return { bad: "Not found in the register." };
  if (!/^https?:/i.test(r[5] || "")) return { bad: "Found in the register, but it has no link." };
  return { ...linkInfo(r[5]), reg: r };
}
function checkLinks() {
  const seen = new Set();
  S.links = $("links").value.split(/\r?\n/).map(s => s.trim()).filter(s => s && !seen.has(s) && seen.add(s)).map(raw => ({ raw, state: "", ...linkInfo(raw) }));
  refreshLinks(true);
}
// ---------- the link list ----------
// states: "" waiting, "downloading", "done" (file arrived and checked), "failed", "requested" (browsers that can't
// watch a folder), "received" (a dropped file matched it)
function linkChip(l) {
  if (l.bad) return ["bad", "Problem", l.bad];
  if (l.state === "done") return ["ok", l.fromFolder ? "Already there" : "Downloaded", mb(l.got.size) + (l.got.name !== l.file && l.got.name ? `, saved as ${l.got.name}` : "")];
  if (l.state === "received") return ["ok", "Received", ""];
  if (l.state === "downloading") return ["busy", l.retry ? "Retrying" : "Downloading", l.bytes ? mb(l.bytes) + " received" : "waiting for SharePoint..."];
  if (l.state === "failed") return ["bad", l.tries > 1 ? "Failed twice" : "Failed", l.why];
  if (l.state === "requested") return ["busy", "Requested", ""];
  return ["", "Waiting", ""];
}
function linkHtml(l, i) {
  const [c, t, note] = linkChip(l);
  const name = l.file ? esc(l.file) + (l.reg && l.reg[2] ? ` <span class="note">${esc(l.reg[2])}</span>` : "") : esc(l.raw);
  const acts = l.bad ? "" : `<a href="${esc(l.url)}" target="_blank" rel="noopener">Download</a> <a href="${esc(l.open)}" target="_blank" rel="noopener">Open</a>`;
  return `<li data-i="${i}" class="${l.state === "downloading" ? "now" : ""}"><span class="chip ${c}">${esc(t)}</span><span class="n" title="${esc(l.raw)}">${name}${note ? `<br><span class="note ${c === "bad" ? "why" : ""}">${esc(note)}</span>` : ""}</span>${acts}</li>`;
}
function paintLink(l) {
  const i = S.links.indexOf(l), li = $("linkList").querySelector(`li[data-i="${i}"]`);
  if (li) li.outerHTML = linkHtml(l, i);
}
function follow(container, el) {   // keeps the current line in view inside its own scrolling box (not the whole page)
  if (!container || !el) return;
  const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.top < c.top + 30 || r.bottom > c.bottom - 30) container.scrollTop += r.top - c.top - (c.height - r.height) / 2;
}
function refreshLinks(say) {
  const ul = $("linkList"), have = new Set(S.docs.map(d => fileKey(d.name)));
  for (const l of S.links) if (!l.state && l.file && have.has(fileKey(l.file))) l.state = "received";
  ul.classList.toggle("hide", !S.links.length);
  ul.innerHTML = S.links.map(linkHtml).join("");
  const good = S.links.filter(l => !l.bad), done = S.links.filter(l => l.state === "done" || l.state === "received").length, failed = S.links.filter(l => l.state === "failed").length;
  $("testLink").disabled = !good.length; $("dlLinks").disabled = !good.length || S.busy;
  $("dlLinks").textContent = failed && done + failed === good.length ? `Retry the ${failed} failed` : done ? `Download the ${good.length - done} not yet downloaded` : "Download all";
  if (S.busy || !say) return;
  if (S.links.length) msg("linkMsg", `${S.links.length} line${S.links.length === 1 ? "" : "s"}: ${good.length} can be downloaded` + (S.links.length - good.length ? `, ${S.links.length - good.length} with a problem (see the list)` : "")
    + (done ? `. ${done} downloaded` : "") + (failed ? `, ${failed} failed` : "") + ".", failed || S.links.length - good.length ? "warn" : done && done === good.length ? "ok" : "info");
  else msg("linkMsg", "");
}

// ---------- the download folder ----------
// A web page can't see the browser's downloads, so it watches the folder the browser saves into (a folder inside
// Downloads: browsers refuse Downloads itself). It sees each file arrive, checks it, and reads it from there.
const canWatch = typeof window.showDirectoryPicker === "function";
function folderStatus() {
  const el = $("dirStatus");
  if (!canWatch) { el.innerHTML = "This browser can't watch a folder, so downloads can't be checked. Use Microsoft Edge or Google Chrome on a computer for checked downloads."; $("pickDir").classList.add("hide"); return; }
  el.innerHTML = S.dir ? `Watching <b>${esc(S.dir.name)}</b>. Downloads must be saved there (see How to set this up).` : "No download folder chosen yet.";
  $("pickDir").textContent = S.dir ? "Change folder" : "Choose download folder";
}
async function pickDir() {
  try {
    const h = await window.showDirectoryPicker({ id: "pdfprep-downloads", mode: "read", startIn: "downloads" });
    S.dir = h; await idb.put("dlDir", h); folderStatus();
    msg("linkMsg", `Watching ${h.name}. Make sure Edge (or Chrome) saves downloads to this folder.`, "ok");
  } catch (e) {
    if (e.name === "AbortError") msg("linkMsg", "No folder was chosen. Choose the folder INSIDE Downloads that your browser saves to (browsers don't allow the Downloads folder itself).", "warn");
    else msg("linkMsg", "That folder can't be used: " + e.message, "bad");
  }
}
async function dirAllowed() {
  try {
    if ((await S.dir.queryPermission({ mode: "read" })) === "granted") return true;
    return (await S.dir.requestPermission({ mode: "read" })) === "granted";
  } catch (_) { return false; }
}
const TEMP = /\.(crdownload|part|partial|tmp|download|opdownload)$|^Unconfirmed \d+|^\.|^~\$/i;
class Watch {
  constructor(dir) { this.dir = dir; this.base = new Map(); this.seen = new Map(); this.claimed = new Set(); }
  async list() { const out = new Map(); for await (const [name, h] of this.dir.entries()) if (h.kind === "file") out.set(name, h); return out; }
  async start() { this.base = await this.list(); }
  async existing(name) {   // a file with this name already in the folder from an earlier run
    for (const [n, h] of this.base) if (!this.claimed.has(n) && !TEMP.test(n) && fileKey(n) === fileKey(name)) { try { return { name: n, file: await h.getFile() }; } catch (_) {} }
    return null;
  }
  async poll() {   // finished files (not seen before, size steady) and files still being written
    const done = [], partial = [];
    for (const [name, h] of await this.list()) {
      if (this.claimed.has(name) || this.base.has(name)) continue;
      let f; try { f = await h.getFile(); } catch (_) { continue; }   // (being renamed right now)
      if (TEMP.test(name)) { partial.push({ name, size: f.size }); continue; }
      const prev = this.seen.get(name); this.seen.set(name, f.size);
      if (prev === f.size && f.size > 0) done.push({ name, file: f });
    }
    return { done, partial };
  }
}
async function checkFile(f, expectZip) {   // is this really the PDF (or zip), or a saved sign in / error page?
  const head = await f.slice(0, 1024).text().catch(() => "");
  if (head.includes("%PDF-") || (expectZip && head.startsWith("PK"))) return "";
  if (/<html|<!doctype|<head|<body/i.test(head)) return "SharePoint sent a web page instead of the file (usually a sign in or \"access denied\" page).";
  if (!f.size) return "The file arrived empty.";
  return "The file that arrived is not a PDF.";
}
function failWith(l, why) {   // on the second try keep the first reason too when it was different
  const first = l.state === "failed" || l.tries > 1 ? (l.firstWhy || "") : "";
  if (l.tries <= 1) l.firstWhy = why;
  l.state = "failed"; l.painted = false;
  l.why = first && first !== why ? `${why} (First try: ${first})` : why;
}
const TO = { nopage: 20000, nothing: 60000, stall: 120000, ...(window.__prepTimeouts || {}) }, PARALLEL = 3;   // (tests shorten the waits)
async function downloadAll() {
  if (!S.links.length) checkLinks();
  let todo = S.links.filter(l => !l.bad && l.state !== "done" && l.state !== "received");
  if (!todo.length) return msg("linkMsg", "Everything in the list has been downloaded.", "ok");
  for (const l of todo) { l.final = false; l.painted = false; l.fromFolder = false; }
  if (!canWatch) return legacyDownload(todo);
  if (!S.dir) return msg("linkMsg", "First press \"Choose download folder\" and pick the folder your browser saves downloads to.", "warn");
  if (!(await dirAllowed())) return msg("linkMsg", "The page needs permission to look in the download folder. Press the button again and choose Allow.", "warn");
  const w = new Watch(S.dir), known = new Set(S.links.filter(l => l.file).map(l => fileKey(l.file)));
  try { await w.start(); } catch (e) { return msg("linkMsg", "Could not look in the download folder (it may have been moved or deleted). Choose it again.", "bad"); }
  const total = todo.length, count = () => { const d = todo.filter(l => l.state === "done").length, f = todo.filter(l => l.state === "failed" && l.final).length; return [d, f]; };
  startJob("Downloading", total);
  const tabs = [];
  let out = ["", "info"], paused = false;
  let pass = 1, round = todo, gotAny = todo.some(l => l.state === "done");
  const show = cur => {   // first go: every link counts once; the second try for failed ones has its own count
    const d = todo.filter(l => l.state === "done").length;
    if (pass === 1) {
      const f = todo.filter(l => l.state === "failed").length, fin = d + f;
      $("jobBar").style.width = (100 * fin) / total + "%";
      $("jobLabel").textContent = `Downloading: ${fin} of ${total} finished (${d} downloaded${f ? `, ${f} failed so far, tried again at the end` : ""})`;
    } else {
      const fin = round.filter(l => l.state === "done" || l.final).length, ok = round.filter(l => l.state === "done").length;
      $("jobBar").style.width = (100 * fin) / round.length + "%";
      $("jobLabel").textContent = `Second try for the ${round.length} that failed: ${fin} of ${round.length} finished (${ok} now downloaded). ${d} of ${total} downloaded in all.`;
    }
    if (cur) { sub(`Now: ${cur.file || cur.raw}` + (cur.bytes ? `, ${mb(cur.bytes)} received` : ", waiting for SharePoint"), 1); $("subBar").parentElement.classList.add("indet"); }
  };
  try {
    for (const l of todo) {   // already in the folder from an earlier go: no need to download again
      if (!l.file) continue;
      const ex = await w.existing(l.file);
      if (ex && !(await checkFile(ex.file, /\.zip$/i.test(l.file)))) { w.claimed.add(ex.name); l.state = "done"; l.fromFolder = true; l.got = { name: ex.name, file: ex.file, size: ex.file.size }; l.final = true; }
    }
    refreshLinks(); show();
    for (pass = 1; pass <= 2 && !paused; pass++) {
      const list = pass === 1 ? todo.filter(l => l.state !== "done") : todo.filter(l => l.state === "failed" && !l.final);
      round = list;
      if (!list.length) break;
      if (pass === 2) { await sleep(1500); }
      for (const l of list) { l.retry = pass === 2; if (pass === 1) l.tries = 0; }
      const busy = new Set(); let next = 0, inARow = 0, pages = 0;
      while (next < list.length || busy.size) {
        if (S.cancel) throw new Cancelled();
        while (next < list.length && !paused) {   // start the next ones (up to 3 at once; a link without a known file name alone)
          const l = list[next], loneBusy = [...busy].some(t => !t.l.file);
          if (busy.size && (!l.file || loneBusy || busy.size >= PARALLEL)) break;
          const win = window.open(l.url, "_blank");
          if (!win) {
            paused = true;
            out = ["The browser blocked the downloads as pop ups. Click the blocked pop up icon at the right end of the address bar, choose \"Always allow pop ups from this site\", then press the button again. It carries on where it stopped.", "bad"];
            break;
          }
          tabs.push(win);
          const t = { l, win, start: Date.now(), grew: Date.now(), bytes: 0, active: false };
          busy.add(t); next++; l.tries = (l.tries || 0) + 1;
          l.state = "downloading"; l.bytes = 0; l.why = ""; paintLink(l);
          follow($("linkList"), $("linkList").querySelector(`li[data-i="${S.links.indexOf(l)}"]`)); show(l);
          await sleep(500);
        }
        if (!busy.size) break;
        await sleep(700);
        let r;
        try { r = await w.poll(); } catch (_) { throw new Error("The download folder could not be read any more (was it moved or renamed?). Choose it again and press the button to carry on."); }
        for (const p of r.partial) {   // a file still being written: show how much has arrived
          const base = fileKey(p.name.replace(/\.(crdownload|part|partial|tmp|download|opdownload)$/i, ""));
          const t = [...busy].find(t => t.l.file && fileKey(t.l.file) === base) || (busy.size === 1 && !known.has(base) ? [...busy][0] : null);
          if (t) { t.active = true; if (p.size !== t.bytes) { t.bytes = p.size; t.grew = Date.now(); t.l.bytes = p.size; paintLink(t.l); } }
        }
        for (const d of r.done) {
          let t = [...busy].find(t => t.l.file && fileKey(t.l.file) === fileKey(d.name));
          if (!t) {   // a file that arrived after its link was marked failed still counts for that link
            const late = todo.find(l => l.state === "failed" && l.file && fileKey(l.file) === fileKey(d.name));
            if (late) t = { l: late, win: { close() {} } };
          }
          if (!t && !known.has(fileKey(d.name))) t = [...busy].find(t => !t.l.file);   // a link without a file name takes only a file no other link expects
          if (!t) continue;   // something else downloaded meanwhile: not ours
          w.claimed.add(d.name); busy.delete(t);
          const bad = await checkFile(d.file, /\.zip$/i.test(t.l.file || d.name));
          if (bad) { failWith(t.l, bad); }
          else { t.l.state = "done"; t.l.final = true; t.l.why = ""; t.l.painted = false; t.l.got = { name: d.name, file: d.file, size: d.file.size }; inARow = 0; pages = 0; gotAny = true; try { t.win.close(); } catch (_) {} }
        }
        for (const t of [...busy]) {   // nothing happening: say why
          const age = Date.now() - t.start;
          let why = "";
          if (!t.active && !t.win.closed && age > TO.nopage) why = "A web page opened instead of a download. SharePoint probably wants you to sign in, or you have no access to this file. Look at the tab that opened.";
          else if (!t.active && age > TO.nothing) why = "Nothing arrived in the download folder. Check that the browser saves downloads to the folder chosen here, and that it doesn't ask where to save each file.";
          else if (t.active && Date.now() - t.grew > TO.stall) why = "The download stopped part way (connection lost?).";
          if (why) { busy.delete(t); failWith(t.l, why); if (!t.active) { inARow++; if (!t.win.closed) pages++; } }
        }
        for (const l of todo) if (l.state === "failed" && !l.painted) { if (pass === 2 && list.includes(l)) l.final = true; l.painted = true; paintLink(l); }
        for (const l of todo) if (l.state === "done" && !l.painted) { l.painted = true; paintLink(l); }
        if (pass === 1 && inARow >= 3 && (pages >= 3 || !gotAny) && !paused) {
          paused = true;
          out = ["Stopped: several downloads in a row failed without a file arriving. SharePoint most likely needs you to sign in: look at the tab that opened, sign in there, then press the button again. It carries on where it stopped.", "bad"];
        }
        show(busy.size ? [...busy][0].l : null);
      }
      for (const l of list) l.painted = false;
    }
    if (!paused) for (const l of todo) if (l.state === "failed") l.final = true;
    const [d, f] = count();
    if (!out[0]) out = f ? [`${d} downloaded, ${f} failed even after a second try (the red lines say why). Press "Retry the ${f} failed" to try them again.`, "warn"] : [`All ${d} downloaded and checked.`, "ok"];
  } catch (e) {
    if (e.cancelled) out = ["Stopped. Files already downloaded are kept; press the button again to carry on.", "warn"];
    else out = [e.message, "bad"];
    for (const l of todo) if (l.state === "downloading") { l.state = ""; l.bytes = 0; }
  } finally {
    $("subBar").parentElement.classList.remove("indet");
    for (const t of tabs) try { if (!t.closed && tabs.indexOf(t) < tabs.length - 1) t.close(); } catch (_) {}
    endJob();
    const got = todo.filter(l => l.state === "done" && l.got && !l.added);
    if (got.length) { got.forEach(l => (l.added = true)); await addFiles(got.map(l => ({ file: l.got.file, path: (S.dir ? S.dir.name + "/" : "") + l.got.name }))); }
    refreshLinks();
    msg("linkMsg", ...out);
    $("filesZipBtn").disabled = !S.docs.length;
    if (got.length && todo.every(l => l.state === "done" || l.final) && out[1] !== "bad") await filesZip();   // the single zip of everything downloaded
  }
}
async function legacyDownload(todo) {   // browsers that can't watch a folder: ask, and match the files you drop
  startJob(`Asking the browser to download ${todo.length} file${todo.length === 1 ? "" : "s"}`, todo.length);
  let n = 0, out = ["", "info"];
  try {
    for (const l of todo) {
      if (S.cancel) throw new Cancelled();
      const win = window.open(l.url, "_blank");
      if (!win) { out = ["The browser blocked the downloads as pop ups. Allow pop ups for this site (icon at the right end of the address bar), then press the button again.", "bad"]; return; }
      l.state = "requested"; n++; paintLink(l); follow($("linkList"), $("linkList").querySelector(`li[data-i="${S.links.indexOf(l)}"]`)); stepJob(n, l.file || l.raw);
      await sleep(1500);
    }
    out = [`${n} download${n === 1 ? "" : "s"} requested. This browser can't check them: drop the downloaded files on the drop box, and links turn green as their files arrive. Any that stay "Requested" did not download.`, "warn"];
  } catch (e) { if (!e.cancelled) throw e; out = [`Stopped after ${n} file${n === 1 ? "" : "s"}.`, "warn"]; }
  finally { endJob(); msg("linkMsg", ...out); }
}

// ---------- report and the zip of downloaded files ----------
function reportCsv() {
  const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = [["Line", "Link or number", "File", "Status", "Size (MB)", "Reason"]];
  S.links.forEach((l, i) => {
    const st = l.bad ? "Problem" : l.state === "done" ? (l.fromFolder ? "Downloaded (already in folder)" : "Downloaded") : l.state === "received" ? "Received (dropped in)" : l.state === "failed" ? "Failed" : l.state === "requested" ? "Requested, not checked" : "Not downloaded";
    rows.push([i + 1, l.raw, (l.got && l.got.name) || l.file || "", st, l.got ? (l.got.size / 1e6).toFixed(2) : "", l.bad || l.why || ""]);
  });
  return "﻿" + rows.map(r => r.map(q).join(",")).join("\r\n");
}
async function crcAll(docs, label) {   // the zip needs a checksum of every file; worked out in the background worker
  const need = docs.filter(d => d.crc == null);
  if (!need.length) return;
  startJob(label, need.length);
  try {
    for (let i = 0; i < need.length; i++) {
      if (S.cancel) throw new Cancelled();
      stepJob(i, need[i].name); sub(need[i].name, i / need.length);
      need[i].crc = (await W.run({ type: "crc", blob: need[i].file })).crc;
      if (i % 5 === 0) follow($("tbody").closest(".tw"), $("tbody").querySelector(`tr[data-id="${need[i].id}"]`));
    }
  } finally { endJob(); }
}
async function filesZip() {
  const docs = S.docs.filter(d => d.include);
  if (!docs.length) return msg("dropMsg", "There are no files in the list to zip.", "warn");
  try {
    await crcAll(docs, "Preparing the zip of downloaded files");
    const names = zipNames(docs), z = new StoreZip();
    for (const d of docs) z.add(names.get(d.id), d.file, d.crc);
    if (S.links.length) { const r = new TextEncoder().encode(reportCsv()); z.add("download-report.csv", new Blob([r]), crc32(r)); }
    const zip = z.finish();
    saveBlob(zip, `downloaded-files-${today()}.zip`);
    msg("dropMsg", `Zip of the downloaded files saved (${mb(zip.size)}, ${docs.length} file${docs.length === 1 ? "" : "s"}` + (S.links.length ? " and download-report.csv" : "") + "). It goes to your browser's download folder.", "ok");
  } catch (e) { msg("dropMsg", e.cancelled ? "Cancelled." : e.message, e.cancelled ? "warn" : "bad"); }
}

// ---------- adding files ----------
let jszipReady = null;
function loadJSZip() {
  return jszipReady || (jszipReady = new Promise((res, rej) => { const s = document.createElement("script"); s.src = JSZIP; s.onload = () => res(window.JSZip); s.onerror = () => { jszipReady = null; rej(new Error("The zip reader could not be loaded. Check the internet connection.")); }; document.head.appendChild(s); }));
}
async function filesFromDrop(dt) {   // files and whole folders, with their folder path
  const out = [], entries = [];
  for (const it of dt.items || []) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
  if (!entries.length) return [...(dt.files || [])].map(f => ({ file: f, path: f.name }));
  const walk = async (en, base) => {
    if (en.isFile) { const f = await new Promise((res, rej) => en.file(res, rej)); out.push({ file: f, path: base + f.name }); return; }
    const rd = en.createReader();
    for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c, base + en.name + "/"); }
  };
  for (const en of entries) await walk(en, "");
  return out;
}
async function addFiles(list) {
  if (S.busy) return msg("dropMsg", "Please wait until the current job finishes, or press Cancel.", "warn");
  let added = 0, skipped = 0, zips = 0, dups = 0;
  const reg = list.find(x => /\.xls[xm]$/i.test(x.file.name));
  if (reg) await loadRegister(reg.file);
  const known = new Set(S.docs.map(d => d.name + "|" + d.size));
  const push = (file, path) => {
    if (known.has(file.name + "|" + file.size)) { dups++; return; }
    known.add(file.name + "|" + file.size);
    const p = parseName(file.name);
    const d = { id: nextId++, file, name: file.name, path, size: file.size, number: p.number, rev: p.rev, title: "", titleSrc: "", include: true,
      state: "new", msg: "", pages: null, read: null, readSize: 0, pageBytes: null, crc: null, sent: false, edited: {} };
    applyRegister(d);
    S.docs.push(d); added++;
  };
  for (const { file, path } of list) {
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") push(file, path);
    else if (/\.zip$/i.test(file.name)) {
      zips++;
      try {
        const JSZip = await loadJSZip(), z = await JSZip.loadAsync(file);
        for (const en of Object.values(z.files)) {
          if (en.dir || !/\.pdf$/i.test(en.name) || /(^|\/)__MACOSX\//.test(en.name)) continue;
          const name = en.name.split("/").pop();
          push(new File([await en.async("blob")], name, { type: "application/pdf" }), file.name + "/" + en.name);
        }
      } catch (e) { msg("dropMsg", `Could not open ${file.name}: ${e.message || "it may be damaged"}`, "bad"); }
    } else if (!/\.xls[xm]$/i.test(file.name) && !/^\./.test(file.name) && !/^(desktop\.ini|thumbs\.db)$/i.test(file.name)) skipped++;
  }
  markDuplicates();
  renderTable(); refreshLinks();
  const parts = [`${added} PDF${added === 1 ? "" : "s"} added` + (zips ? ` (including from ${zips} zip file${zips === 1 ? "" : "s"})` : "") + "."];
  if (dups) parts.push(`${dups} already in the list.`);
  if (skipped) parts.push(`${skipped} file${skipped === 1 ? " was" : "s were"} not PDF or zip and ${skipped === 1 ? "was" : "were"} ignored.`);
  if (added || dups || skipped) msg("dropMsg", parts.join(" "), added ? "ok" : "warn");
}
function markDuplicates(prefer) {   // two files for the same number and revision: keep one, leave the other out
  const rank = d => (d.id === prefer ? 0 : /\s\(\d+\)\.pdf$/i.test(d.name) ? 2 : 1);
  const keep = new Map();
  for (const d of S.docs) d.dupOf = "";
  for (const d of S.docs) {
    if (!d.include || !d.number) continue;
    const k = d.number + "_" + d.rev, o = keep.get(k);
    if (!o) keep.set(k, d);
    else if (rank(d) < rank(o)) { o.include = false; o.dupOf = d; keep.set(k, d); }
    else { d.include = false; d.dupOf = o; }
  }
}

// ---------- the table ----------
function chipFor(d) {
  if (!d.include) return ["", d.dupOf ? `Left out: same number and revision as row ${S.docs.indexOf(d.dupOf) + 1}` : "Left out"];
  if (d.state === "working") return ["busy", d.msg || "Working..."];
  if (d.state === "error") return ["bad", d.msg];
  const warn = [];
  if (!libOk(d)) warn.push(!d.rev ? "No revision found: type it in" : "The library only accepts A to Z, 0 to 9 and - in the number, and up to 4 letters or digits in the revision");
  if (d.size > GH_MAX) warn.push("Over 95 MB: GitHub can't take it, it goes in the zip only");
  if (d.state === "ready") { const k = d.kept ? " (original used, already light)" : "";
    return warn.length ? ["warn", "Ready" + k + ". " + warn.join(". ")] : ["ok", (d.sent ? "Ready, uploaded" : "Ready") + k]; }
  return warn.length ? ["warn", warn.join(". ")] : ["", "Waiting"];
}
function rowHtml(d, i) {
  const [c, t] = chipFor(d);
  const saved = d.readSize ? `${mb(d.readSize)} <span class="note">(${Math.max(0, Math.round(100 - (100 * d.readSize) / d.size))}% smaller)</span>` : "";
  return `<tr data-id="${d.id}" class="${d.include ? "" : "off"}">
    <td><input type="checkbox" class="inc" ${d.include ? "checked" : ""} aria-label="Include"></td>
    <td class="fn" title="${esc(d.path || d.name)}">${i + 1}. ${esc(d.name)}</td>
    <td class="c-num"><input type="text" class="e-number" value="${esc(d.number)}" spellcheck="false"></td>
    <td class="c-rev"><input type="text" class="e-rev" value="${esc(d.rev)}" spellcheck="false"></td>
    <td class="c-title"><input type="text" class="e-title" value="${esc(d.title)}" title="${d.titleSrc === "register" ? "Title from the register" : d.titleSrc === "PDF" ? "Title stored in the PDF" : ""}"></td>
    <td class="num">${d.pages ?? ""}</td><td class="num">${mb(d.size)}</td><td class="num">${saved}</td>
    <td class="st"><span class="chip ${c}">${esc(t)}</span></td></tr>`;
}
function renderTable() {
  const tb = $("tbody");
  tb.innerHTML = S.docs.length ? S.docs.map(rowHtml).join("") : `<tr><td colspan="9" class="note" style="padding:16px">No files yet.</td></tr>`;
  summary();
}
function updateRow(d) {   // one row only, keeping the typing box the user is in
  const tr = $("tbody").querySelector(`tr[data-id="${d.id}"]`);
  if (!tr) return;
  const [c, t] = chipFor(d);
  tr.className = d.include ? "" : "off";
  tr.querySelector(".st").innerHTML = `<span class="chip ${c}">${esc(t)}</span>`;
  tr.children[5].textContent = d.pages ?? "";
  tr.children[7].innerHTML = d.readSize ? `${mb(d.readSize)} <span class="note">(${Math.max(0, Math.round(100 - (100 * d.readSize) / d.size))}% smaller)</span>` : "";
  const ti = tr.querySelector(".e-title"); if (document.activeElement !== ti && ti.value !== d.title) ti.value = d.title;
}
function summary() {
  const inc = S.docs.filter(d => d.include), ready = inc.filter(d => d.state === "ready"), waiting = inc.filter(d => d.state !== "ready");
  const failed = waiting.filter(d => d.state === "error").length, fresh = waiting.length - failed;
  const orig = inc.reduce((a, d) => a + d.size, 0), read = ready.reduce((a, d) => a + d.readSize, 0), origReady = ready.reduce((a, d) => a + d.size, 0);
  $("countNote").textContent = S.docs.length ? `${inc.length} of ${S.docs.length} included, ${mb(orig)}` : "";
  $("prepBtn").disabled = S.busy || !waiting.length;
  $("prepBtn").textContent = fresh ? (ready.length || failed ? `Make reading copies (${fresh} left)` : "Make reading copies") : failed ? `Try the ${failed} with a problem again` : "Make reading copies";
  $("prepNote").textContent = !inc.length ? "" : fresh ? `${fresh} waiting` + (failed ? `, ${failed} with a problem` : "") : failed ? `${failed} with a problem (untick them to leave them out)` : "All reading copies are made.";
  $("stats").innerHTML = ready.length ? `<span>Originals: <b>${mb(origReady)}</b></span><span>Reading copies: <b>${mb(read)}</b></span><span>Saved: <b>${mb(origReady - read)}</b> (${Math.round(100 - (100 * read) / Math.max(1, origReady))}%)</span><span>Pages: <b>${ready.reduce((a, d) => a + d.pages, 0).toLocaleString()}</b></span>` : "";
  const can = !S.busy && ready.length > 0;
  $("filesZipBtn").disabled = S.busy || !inc.length;
  $("zipBtn").disabled = !can; $("ghBtn").disabled = !can;
  $("outNote").textContent = ready.length && waiting.length ? `Only the ${ready.length} finished document${ready.length === 1 ? "" : "s"} will be included.` : "";
  $("allBox").checked = S.docs.length > 0 && S.docs.every(d => d.include);
}
function onEdit(e) {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const d = S.docs.find(x => x.id === +tr.dataset.id); if (!d) return;
  const t = e.target;
  if (t.classList.contains("inc")) { d.include = t.checked; if (d.include) markDuplicates(d.id); else d.dupOf = ""; renderTable(); return; }
  if (t.classList.contains("e-number")) { d.number = t.value.trim().toUpperCase(); d.edited.number = true; }
  else if (t.classList.contains("e-rev")) { d.rev = t.value.trim().toUpperCase(); d.edited.rev = true; }
  else if (t.classList.contains("e-title")) { d.title = t.value; d.titleSrc = "typed"; d.edited.title = true; }
  d.sent = false;
  if (e.type === "change") { if (t.classList.contains("e-number") || t.classList.contains("e-rev")) t.value = t.value.trim().toUpperCase(); }
  updateRow(d); summary();
}

// ---------- background worker ----------
const W = {
  w: null, calls: new Map(), seq: 0,
  ensure() {
    if (this.w) return this.w;
    this.w = new Worker("prep-worker.js", { type: "module" });
    this.w.onmessage = e => { const m = e.data, c = this.calls.get(m.id); if (!c) return;
      if (m.type === "progress") c.onp && c.onp(m);
      else { this.calls.delete(m.id); m.type === "done" ? c.res(m) : c.rej(new Error(m.error)); } };
    this.w.onerror = e => { e.preventDefault && e.preventDefault();
      const err = new Error("The background worker could not start or stopped. Use a current Edge, Chrome, Firefox or Safari, check the internet connection, and reload the page.");
      for (const c of this.calls.values()) c.rej(err); this.calls.clear(); this.w = null; };
    return this.w;
  },
  run(m, onp) { const id = ++this.seq; return new Promise((res, rej) => { this.calls.set(id, { res, rej, onp }); this.ensure().postMessage({ ...m, id }); }); },
  kill() { if (this.w) { this.w.terminate(); this.w = null; } for (const c of this.calls.values()) c.rej(new Cancelled()); this.calls.clear(); },
};

// ---------- job bar ----------
let job = { total: 0 };
function startJob(label, total) {
  S.busy = true; S.cancel = false; S.abort = new AbortController(); job = { total, label };
  $("jobbar").classList.add("show"); $("jobLabel").textContent = label; $("jobBar").style.width = "0"; sub("", 0); summary();
  $("dlLinks").disabled = true;
}
function stepJob(done, detail) { $("jobBar").style.width = (100 * done) / Math.max(1, job.total) + "%"; $("jobLabel").textContent = `${job.label}: ${done} of ${job.total}` + (detail ? `, ${detail}` : ""); }
function sub(label, frac) { $("subLabel").textContent = label; $("subBar").style.width = Math.round(100 * Math.max(0, Math.min(1, frac))) + "%"; $("subBar").parentElement.classList.toggle("hide", !label); }
function endJob() { S.busy = false; S.abort = null; $("jobbar").classList.remove("show"); summary(); refreshLinks(); }
$("cancelBtn").onclick = () => { S.cancel = true; if (S.abort) S.abort.abort(); W.kill(); $("jobLabel").textContent = "Stopping..."; };

// ---------- 3. reading copies ----------
async function prepAll() {
  const todo = S.docs.filter(d => d.include && d.state !== "ready");
  if (!todo.length) return;
  msg("prepMsg", "");
  startJob("Making reading copies", todo.length);
  let ok = 0, bad = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (S.cancel) throw new Cancelled();
      const d = todo[i];
      d.state = "working"; d.msg = "Opening..."; updateRow(d); stepJob(i, d.name); sub(d.name, 0);
      follow($("tbody").closest(".tw"), $("tbody").querySelector(`tr[data-id="${d.id}"]`));
      try {
        const r = await W.run({ type: "prep", file: d.file, dpi: +set.dpi, quality: +set.quality, keepText: !!set.keepText }, p => {
          d.msg = `Page ${p.page} of ${p.pages}`; updateRow(d); sub(`${d.name}: page ${p.page} of ${p.pages}`, (p.page - 1) / p.pages);
        });
        d.pages = r.pages; d.read = new Blob([r.read], { type: "application/pdf" }); d.readSize = d.read.size; d.pageBytes = r.pageBytes; d.crc = r.crc;
        if (!d.title && r.title && !d.edited.title) { d.title = r.title; d.titleSrc = "PDF"; }
        d.state = "ready"; d.msg = ""; ok++;
        d.kept = r.kept;
      } catch (e) {
        if (e.cancelled || S.cancel) { d.state = "new"; d.msg = ""; updateRow(d); throw new Cancelled(); }
        d.state = "error"; d.msg = e.message; bad++;
      }
      updateRow(d); stepJob(i + 1, d.name); summary();
      await sleep(0);
    }
    msg("prepMsg", bad ? `${ok} done, ${bad} with a problem (see the red lines in the list). The rest can still be downloaded and uploaded.` : `All ${ok} reading copies are made.`, bad ? "warn" : "ok");
  } catch (e) {
    if (e.cancelled) msg("prepMsg", `Cancelled. ${ok} reading cop${ok === 1 ? "y was" : "ies were"} made and kept; press the button again to carry on.`, "warn");
    else msg("prepMsg", e.message, "bad");
  } finally { endJob(); }
}

// ---------- 4a. batches ----------
const readyDocs = () => S.docs.filter(d => d.include && d.state === "ready");
const keyOf = docs => JSON.stringify([set.limitMB, docs.map(d => [d.id, d.number, d.rev, d.title, d.readSize])]);
async function ensureBatches() {
  const docs = readyDocs(), key = keyOf(docs);
  if (S.batches && S.batchKey === key) return S.batches;
  const limit = Math.max(1, +set.limitMB) * 1e6, budget = limit - 60000;   // room for the contents page
  const items = [];
  for (const d of docs) {
    if (d.readSize <= budget) { items.push({ d, from: 1, to: d.pages, est: d.readSize }); continue; }
    const f = d.readSize / Math.max(1, d.pageBytes.reduce((a, b) => a + b, 0)), parts = [];
    let from = 1, acc = 0;
    for (let p = 1; p <= d.pages; p++) { const b = d.pageBytes[p - 1] * f; if (acc + b > budget && p > from) { parts.push([from, p - 1, acc]); from = p; acc = 0; } acc += b; }
    parts.push([from, d.pages, acc]);
    parts.forEach(([a, b, est], k) => items.push({ d, from: a, to: b, est, part: `part ${k + 1} of ${parts.length}, its pages ${a} to ${b}` }));
  }
  const guess = Math.max(1, Math.ceil(items.reduce((a, it) => a + it.est, 0) / limit));
  startJob("Making batches", guess);
  const batches = [], q = items.slice(), made = new Date().toLocaleString();
  try {
    while (q.length) {
      if (S.cancel) throw new Cancelled();
      const grp = []; let est = 40000;
      while (q.length && (!grp.length || est + q[0].est <= limit)) { est += q[0].est; grp.push(q.shift()); }
      const name = `batch-${batches.length + 1}.pdf`;
      for (;;) {
        sub(`${name}: ${grp.length} document${grp.length === 1 ? "" : "s"}`, 0);
        const r = await W.run({ type: "batch", name, made, items: grp.map(it => ({ blob: it.d.read, from: it.from, to: it.to, number: it.d.number, rev: it.d.rev, title: it.d.title, part: it.part || "" })) },
          p => sub(`${name}: document ${p.page} of ${p.pages}`, p.page / p.pages));
        if (r.bytes.byteLength > limit && grp.length > 1) { q.unshift(grp.pop()); continue; }   // estimate was a little low: move the last one on
        batches.push({ name, blob: new Blob([r.bytes], { type: "application/pdf" }), size: r.bytes.byteLength, crc: r.crc, pages: r.pages,
          entries: grp.map((it, k) => ({ d: it.d, from: it.from, to: it.to, part: it.part || "", start: r.starts[k][0], end: r.starts[k][1] })), over: r.bytes.byteLength > limit });
        break;
      }
      job.total = Math.max(job.total, batches.length + (q.length ? 1 : 0)); stepJob(batches.length, name);
    }
  } catch (e) { endJob(); throw e; }
  endJob();
  S.batches = batches; S.batchKey = key;
  return batches;
}
function manifest(batches, extra) {
  const where = new Map();
  const rg = (a, b) => (a === b ? `${a}` : `${a}-${b}`);
  for (const b of batches) for (const e of b.entries) { if (!where.has(e.d.id)) where.set(e.d.id, []); where.get(e.d.id).push({ batch: b.name, pages: rg(e.start, e.end), ...(e.part ? { part: e.part, documentPages: rg(e.from, e.to) } : {}) }); }
  const names = zipNames(readyDocs());
  return {
    generated: new Date().toISOString(), tool: "PDF Prep for Project Library", ...extra,
    settings: { readingCopyDpi: +set.dpi, jpegQuality: +set.quality, batchLimitMB: +set.limitMB, textLayer: !!set.keepText },
    documents: readyDocs().map(d => ({ number: d.number, rev: d.rev, title: d.title || "", originalFile: d.name, ...(d.path && d.path !== d.name ? { source: d.path } : {}),
      pages: d.pages, size: d.size, readingCopySize: d.readSize, fileInFilesZip: names.get(d.id), libraryFile: `${d.number}_Rev${d.rev}.pdf`, batches: where.get(d.id) || [] })),
    batches: batches.map(b => ({ file: b.name, size: b.size, pages: b.pages, documents: b.entries.map(e => ({ number: e.d.number, rev: e.d.rev, pages: rg(e.start, e.end), ...(e.part ? { part: e.part } : {}) })) })),
  };
}
function zipNames(docs) {   // original names, made unique if two folders had the same name
  const used = new Set(), out = new Map();
  for (const d of docs) { let n = d.name, k = 2; while (used.has(n.toLowerCase())) n = d.name.replace(/(\.pdf)?$/i, ` (${k++})$1`); used.add(n.toLowerCase()); out.set(d.id, n); }
  return out;
}

// ---------- 4b. one zip ----------
const CRCT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
class StoreZip {   // a plain "stored" zip (PDFs don't shrink anyway) that points at the files instead of copying them
  constructor() { this.parts = []; this.cd = []; this.off = 0; this.n = 0; const d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); this.date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); }
  add(name, blob, crc) {
    const nm = new TextEncoder().encode(name), size = blob.size;
    if (this.off + size > 0xfffffff0 || size > 0xfffffff0) throw new Error("This is more than 4 GB, too much for one zip. Untick some rows and download in two goes.");
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, this.time, true); h.setUint16(12, this.date, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, this.time, true); c.setUint16(14, this.date, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, this.off, true);
    this.parts.push(h.buffer, nm, blob); this.cd.push(c.buffer, nm);
    this.off += 30 + nm.length + size; this.n++;
  }
  finish() {
    const cdSize = this.cd.reduce((a, p) => a + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.n, true); e.setUint16(10, this.n, true); e.setUint32(12, cdSize, true); e.setUint32(16, this.off, true);
    return new Blob([...this.parts, ...this.cd, e.buffer], { type: "application/zip" });
  }
}
function saveBlob(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
}
async function downloadZip() {
  msg("outMsg", "");
  try {
    const batches = await ensureBatches(), docs = readyDocs();
    const z = new StoreZip();
    for (const b of batches) z.add("batches/" + b.name, b.blob, b.crc);
    const m = new TextEncoder().encode(JSON.stringify(manifest(batches, {}), null, 2));
    z.add("manifest.json", new Blob([m]), crc32(m));
    if (S.links.length) { const r = new TextEncoder().encode(reportCsv()); z.add("download-report.csv", new Blob([r]), crc32(r)); }
    const zip = z.finish();
    saveBlob(zip, `reading-package-${today()}.zip`);
    const over = batches.filter(b => b.over).length;
    msg("outMsg", `Reading package saved (${mb(zip.size)}): ${batches.length} batch${batches.length === 1 ? "" : "es"} covering ${docs.length} document${docs.length === 1 ? "" : "s"}, manifest.json` + (S.links.length ? " and download-report.csv" : "") + ". It goes to your browser's download folder." + (over ? ` ${over} batch${over === 1 ? " is" : "es are"} over the limit because a single page is bigger than it: raise the limit or lower the quality.` : ""), over ? "warn" : "ok");
  } catch (e) {
    if (e.cancelled) msg("outMsg", "Cancelled.", "warn"); else msg("outMsg", e.message, "bad");
  }
}

// ---------- 4c. GitHub ----------
class GhError extends Error { constructor(m, status) { super(m); this.status = status; } }
const R = `/repos/${REPO}`;
function explain(status, why, what) {
  if (status === 401) return "GitHub did not accept the token. It may be mistyped, expired or revoked. Make a new one and paste it in Settings.";
  if (status === 403) return `GitHub says the token is not allowed to ${what || "do this"}. On GitHub, edit the token: Repository access must include ${REPO}, and the permission Contents must be set to Read and write.` + (why ? ` (GitHub said: ${why})` : "");
  if (status === 404) return `GitHub can't find ${REPO}` + (what === "branch" ? ` or its branch "${set.branch}"` : "") + ` with this token. Check the token's Repository access includes ${REPO}, and that the branch name in Settings is right.`;
  if (status === 409) return "GitHub says the repository is empty or busy. Try again in a minute.";
  if (status === 413) return "This file is too large for GitHub.";
  if (status === 422) return `GitHub refused ${what || "this request"}: ${why || "the data was not accepted"}.`;
  return `GitHub answered with error ${status}` + (why ? `: ${why}` : "") + ".";
}
async function gh(method, path, body, { what, ok404, note } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (S.cancel) throw new Cancelled();
    let r;
    try {
      r = await fetch("https://api.github.com" + path, { method, body, signal: S.abort && S.abort.signal,
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) } });
    } catch (e) {
      if (S.cancel) throw new Cancelled();
      if (attempt < 4) { await countdown(2 ** (attempt + 1), "No answer from GitHub, trying again", note); continue; }
      throw new GhError("Couldn't reach GitHub. Check the internet connection, then press Upload again. Files already sent are remembered.");
    }
    if (r.ok) return r.status === 204 ? {} : r.json();
    if (r.status === 404 && ok404) return null;
    const j = await r.json().catch(() => ({})), why = j.message || "";
    const ra = +r.headers.get("retry-after") || 0, left = r.headers.get("x-ratelimit-remaining"), reset = +r.headers.get("x-ratelimit-reset") || 0;
    if ((r.status === 403 || r.status === 429) && (ra || /secondary rate|abuse/i.test(why))) {
      if (attempt < 5) { await countdown(ra || 60, "GitHub asked to slow down, waiting", note); continue; }
      throw new GhError("GitHub keeps asking to slow down. Wait a few minutes, then press Upload again. Files already sent are remembered.", r.status);
    }
    if ((r.status === 403 || r.status === 429) && left === "0") {
      const at = reset ? new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "within the hour";
      throw new GhError(`GitHub's hourly limit for this token is used up. It resets at ${at}. Press Upload again after that. Files already sent are remembered.`, r.status);
    }
    if (r.status >= 500 && attempt < 4) { await countdown(2 ** (attempt + 2), `GitHub had a problem (${r.status}), trying again`, note); continue; }
    throw new GhError(explain(r.status, why, what), r.status);
  }
}
async function countdown(sec, text, note) {
  for (let s = Math.ceil(sec); s > 0; s--) { if (S.cancel) throw new Cancelled(); sub(`${text} in ${s} s`, 0); if (note) note(`${text} in ${s} s`); await sleep(1000); }
}
const b64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => { const s = fr.result; res(s.slice(s.indexOf(",") + 1)); }; fr.onerror = () => rej(new Error("Could not read the file from disk. If it is in a OneDrive folder, make sure it is downloaded to this computer (not online only).")); fr.readAsDataURL(blob); });

async function upload() {
  msg("outMsg", "");
  if (!token) { msg("outMsg", "Paste a GitHub token in Settings first.", "warn"); return openSettings(true); }
  let batches;
  try { batches = await ensureBatches(); } catch (e) { return msg("outMsg", e.cancelled ? "Cancelled." : e.message, e.cancelled ? "warn" : "bad"); }
  const docs = readyDocs(), skipped = [], files = [];
  const sendDocs = docs.filter(d => {
    if (d.sent) return false;
    if (!libOk(d)) { skipped.push(`${d.name}: number or revision not accepted by the library, fix it in the list`); return false; }
    if (d.size > GH_MAX) { skipped.push(`${d.name}: ${mb(d.size)} is over GitHub's limit (95 MB here, 100 MB on GitHub). It is in the zip only.`); return false; }
    return true;
  });
  const batchesDue = S.batchesSent !== S.batchKey;
  if (!sendDocs.length && !batchesDue) return msg("outMsg", "Everything has already been uploaded." + (skipped.length ? "\nNot uploaded:\n" + skipped.join("\n") : ""), skipped.length ? "warn" : "ok");
  const ul = $("upList"); ul.classList.remove("hide");
  const uploaded = new Date().toISOString();
  for (const d of sendDocs) {
    const base = `uploads/${d.number}_Rev${d.rev}`;
    const note = { number: d.number, rev: d.rev, uploaded, file: d.name, title: d.title || "" };
    files.push({ path: base + ".json", text: JSON.stringify(note, null, 1), d }, { path: base + ".pdf", blob: d.file, d, key: "doc" + d.id + "|" + d.size });
  }
  ul.innerHTML = files.filter(f => f.blob).map((f, i) => `<li data-p="${esc(f.path)}"><span class="chip">Waiting</span><span class="n">${esc(f.path)}</span><span class="note">${mb(f.blob.size)}</span></li>`).join("")
    + skipped.map(s => `<li><span class="chip warn">Skipped</span><span class="n">${esc(s)}</span></li>`).join("");
  const li = p => ul.querySelector(`li[data-p="${CSS.escape(p)}"]`);
  const mark = (p, c, t) => { const el = li(p); if (el) { el.querySelector(".chip").outerHTML = `<span class="chip ${c}">${esc(t)}</span>`; if (c === "busy") follow(ul, el); } };
  startJob("Uploading to GitHub", 1);
  let folder = "";
  try {
    sub("Checking the token and the repository...", 0);
    await gh("GET", R, null, { what: "read the repository" });
    await gh("GET", `${R}/git/ref/heads/${encodeURIComponent(set.branch)}`, null, { what: "branch" });
    if (batchesDue) {
      const base = `claude-batches/${today()}`;
      for (let k = 1; ; k++) { const f = k === 1 ? base : `${base}-${k}`; if (!(await gh("GET", `${R}/contents/${f}?ref=${encodeURIComponent(set.branch)}`, null, { ok404: true }))) { folder = f; break; } }
      for (const b of batches) files.push({ path: `${folder}/${b.name}`, blob: b.blob, key: "batch|" + S.batchKey + "|" + b.name });
      files.push({ path: `${folder}/manifest.json`, text: JSON.stringify(manifest(batches, { githubFolder: folder, uploadedDocuments: sendDocs.map(d => `uploads/${d.number}_Rev${d.rev}.pdf`) }), null, 2) });
      ul.innerHTML += files.filter(f => f.blob && f.path.startsWith(folder)).map(f => `<li data-p="${esc(f.path)}"><span class="chip">Waiting</span><span class="n">${esc(f.path)}</span><span class="note">${mb(f.blob.size)}</span></li>`).join("");
    }
    const big = files.filter(f => f.blob), total = big.reduce((a, f) => a + f.blob.size, 0);
    job.total = big.length; let sentBytes = 0, n = 0, lastPost = 0;
    const failed = new Set();
    for (const f of big) {
      if (S.cancel) throw new Cancelled();
      stepJob(n, f.path);
      if (S.blobShas.has(f.key)) { f.sha = S.blobShas.get(f.key); mark(f.path, "ok", "Sent"); }
      else {
        mark(f.path, "busy", `Sending ${mb(f.blob.size)}`);
        sub(`Sending ${f.path} (${mb(f.blob.size)}). Sent so far: ${mb(sentBytes)} of ${mb(total)}`, sentBytes / total);
        try {
          const wait = 800 - (Date.now() - lastPost); if (wait > 0) await sleep(wait);   // stays under GitHub's 80 per minute
          lastPost = Date.now();
          const data = await b64(f.blob);
          const r = await gh("POST", `${R}/git/blobs`, '{"encoding":"base64","content":"' + data + '"}', { what: "upload " + f.path, note: t => mark(f.path, "busy", t) });
          f.sha = r.sha; S.blobShas.set(f.key, r.sha); mark(f.path, "ok", "Sent");
        } catch (e) {
          if (e.cancelled || S.cancel) throw new Cancelled();
          if (e.status === 401 || e.status === 404 || (e.status === 403 && !/limit/i.test(e.message))) throw e;   // the token itself is the problem: stop here
          failed.add(f.path); mark(f.path, "bad", "Failed: " + e.message);
          if (f.d) failed.add(f.path.replace(/\.pdf$/, ".json"));
        }
      }
      sentBytes += f.blob.size; n++; stepJob(n, f.path);
    }
    const tree = files.filter(f => !failed.has(f.path)).map(f => f.blob ? { path: f.path, mode: "100644", type: "blob", sha: f.sha } : { path: f.path, mode: "100644", type: "blob", content: f.text });
    const docCount = files.filter(f => f.d && f.blob && !failed.has(f.path)).length, batchCount = batches.length;
    if (!tree.length) throw new GhError("Nothing could be sent, so nothing was saved on GitHub. See the red lines.");
    sub("Saving everything on GitHub as one commit...", 1);
    const message = `Upload ${docCount} document${docCount === 1 ? "" : "s"}` + (folder ? ` and ${batchCount} reading batch${batchCount === 1 ? "" : "es"} (${folder})` : "") + " from PDF Prep";
    for (let tries = 0; ; tries++) {
      const ref = await gh("GET", `${R}/git/ref/heads/${encodeURIComponent(set.branch)}`, null, { what: "branch" });
      const head = ref.object.sha, hc = await gh("GET", `${R}/git/commits/${head}`);
      const t = await gh("POST", `${R}/git/trees`, JSON.stringify({ base_tree: hc.tree.sha, tree }), { what: "the list of files" });
      const c = await gh("POST", `${R}/git/commits`, JSON.stringify({ message, tree: t.sha, parents: [head] }), { what: "the commit" });
      try { await gh("PATCH", `${R}/git/refs/heads/${encodeURIComponent(set.branch)}`, JSON.stringify({ sha: c.sha, force: false }), { what: "the branch update" }); break; }
      catch (e) { if (e.status === 422 && tries < 4) { sub("Someone else updated the repository at the same moment, trying again...", 1); await sleep(1500); continue; } throw e; }
    }
    for (const d of sendDocs) if (!failed.has(`uploads/${d.number}_Rev${d.rev}.pdf`)) { d.sent = true; updateRow(d); }
    if (folder && ![...failed].some(p => p.startsWith(folder))) S.batchesSent = S.batchKey;
    const lines = [`Saved on GitHub in one commit: ${docCount} document${docCount === 1 ? "" : "s"} in uploads/` + (folder ? `, ${batchCount} batch${batchCount === 1 ? "" : "es"} and manifest.json in ${folder}/` : "") + ". Your ingest Action will file the documents in a few minutes."];
    if (failed.size) lines.push(`${[...failed].filter(p => p.endsWith(".pdf")).length} file${failed.size === 1 ? "" : "s"} failed (red lines). Press Upload again to send only those.`);
    if (skipped.length) lines.push("Not uploaded:\n" + skipped.join("\n"));
    msg("outMsg", lines.join("\n"), failed.size || skipped.length ? "warn" : "ok");
  } catch (e) {
    if (e.cancelled) msg("outMsg", "Cancelled. Nothing was saved on GitHub yet (files are only saved together at the end). Files already sent are remembered for next time.", "warn");
    else msg("outMsg", e.message, "bad");
  } finally { endJob(); }
}

// ---------- settings ----------
function openSettings(focusToken) {
  $("sQuality").value = set.quality; $("sDpi").value = set.dpi; $("sLimit").value = set.limitMB; $("sText").checked = !!set.keepText;
  $("sToken").value = token; $("sBranch").value = set.branch;
  $("sTokenNote").textContent = token ? "A token is saved on this device." : "No token saved.";
  $("settings").showModal();
  if (focusToken) $("sToken").focus();
}
function closeSettings() {
  const clamp = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  const next = { quality: clamp($("sQuality").value, 0.1, 0.95, DEF.quality), dpi: clamp($("sDpi").value, 50, 300, DEF.dpi), limitMB: clamp($("sLimit").value, 2, 500, DEF.limitMB),
    keepText: $("sText").checked, branch: $("sBranch").value.trim() || "main" };
  const redo = next.quality !== set.quality || next.dpi !== set.dpi || next.keepText !== set.keepText;
  set = next; LS.set("pdfprep.settings", JSON.stringify(set));
  const t = $("sToken").value.trim();
  if (t !== token) { token = t; if (t) LS.set("pdfprep.ghToken", t); else LS.del("pdfprep.ghToken"); }
  $("settings").close();
  if (redo && S.docs.some(d => d.state === "ready")) {
    for (const d of S.docs) if (d.state === "ready") { d.state = "new"; d.read = null; d.readSize = 0; }
    S.batches = null; renderTable();
    msg("prepMsg", "Picture settings changed, so the reading copies need making again. Press Make reading copies.", "warn");
  }
  summary();
}

// ---------- wiring ----------
$("openSettings").onclick = () => openSettings(false);
$("sClose").onclick = closeSettings;
$("settings").addEventListener("cancel", e => { e.preventDefault(); closeSettings(); });
$("sForget").onclick = () => { token = ""; $("sToken").value = ""; LS.del("pdfprep.ghToken"); $("sTokenNote").textContent = "Token forgotten on this device."; };
$("regInput").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) loadRegister(f); };
$("regForget").onclick = async () => { S.reg = null; await idb.del("register"); $("regStatus").textContent = "Register removed from this browser."; regStatus(); refreshLinks(); };
$("links").value = LS.get("pdfprep.links") || "";
$("links").addEventListener("input", () => LS.set("pdfprep.links", $("links").value));
$("checkLinks").onclick = () => { if (S.busy) return; checkLinks(); };
$("testLink").onclick = () => { const l = S.links.find(x => !x.bad); if (l) { window.open(l.open, "_blank", "noopener"); msg("linkMsg", "The first file opened in a new tab. If it shows the document, your sign in works and Download all will work. If it asks you to sign in, sign in there, then come back.", "info"); } };
$("dlLinks").onclick = () => downloadAll();
$("pickDir").onclick = pickDir;
$("filesZipBtn").onclick = filesZip;
const drop = $("drop");
["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", async e => { msg("dropMsg", "Reading the dropped files...", "info"); try { await addFiles(await filesFromDrop(e.dataTransfer)); } catch (err) { msg("dropMsg", "Could not read what was dropped: " + err.message, "bad"); } });
window.addEventListener("dragover", e => e.preventDefault());   // a near miss must not open the PDF in place of this page
window.addEventListener("drop", e => e.preventDefault());
$("fileInput").onchange = e => { const l = [...e.target.files].map(f => ({ file: f, path: f.name })); e.target.value = ""; addFiles(l); };
$("dirInput").onchange = e => { const l = [...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })); e.target.value = ""; addFiles(l); };
$("tbody").addEventListener("input", onEdit);
$("tbody").addEventListener("change", onEdit);
$("allBox").onchange = e => { for (const d of S.docs) { d.include = e.target.checked; d.dupOf = ""; } if (e.target.checked) markDuplicates(); renderTable(); };
$("clearAll").onclick = () => { if (S.busy || !S.docs.length) return; if (!confirm(`Remove all ${S.docs.length} files from the list? (Nothing is deleted from your computer.)`)) return; S.docs = []; S.batches = null; for (const l of S.links) { if (l.state === "received") l.state = ""; l.added = false; } renderTable(); refreshLinks(); msg("dropMsg", ""); msg("prepMsg", ""); msg("outMsg", ""); $("upList").classList.add("hide"); };
$("prepBtn").onclick = prepAll;
$("zipBtn").onclick = downloadZip;
$("ghBtn").onclick = upload;
window.addEventListener("beforeunload", e => { if (S.busy || S.docs.some(d => d.state === "ready")) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  const r = await idb.get("register");
  if (r && r.rows) { indexRegister(r); regStatus(); }
  if (canWatch) { const h = await idb.get("dlDir"); if (h && h.kind === "directory") S.dir = h; }
  folderStatus();
  if ($("links").value.trim()) checkLinks();
  summary();
})();

// for the automated tests only
window.__prep = { S, parseName, linkInfo, rkCmp, StoreZip, crc32, set: () => set, reportCsv };
