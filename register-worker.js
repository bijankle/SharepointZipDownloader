// Background worker: reads a document register (.xlsx or .xlsm) and returns one row per document:
// [number, rev, title, status, file name, SharePoint link]. Finds the columns by their headings (Doc Number, Rev,
// Title, Status, URL / Link, File name); the link is the cell's hyperlink if it has one. Nothing leaves this computer.
importScripts("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");

self.onmessage = async e => {
  try { postMessage({ ok: true, rows: await parse(e.data.file) }); }
  catch (err) { postMessage({ ok: false, error: String((err && err.message) || err) }); }
};

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dec = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, k) => k[0] === "#" ? String.fromCodePoint(k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : +k.slice(1)) : ENT[k] ?? m)
  .replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const texts = xml => { let s = "", m; const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g; while ((m = re.exec(xml))) s += m[1]; return dec(s); };
const attr = (a, name) => { const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(a); return m ? m[1] : null; };
const colOf = ref => ref.replace(/\d+$/, "");
const rowOf = ref => +ref.replace(/^[A-Z]+/, "");

async function parse(file) {
  const zip = await JSZip.loadAsync(file);
  const read = p => { const f = zip.file(p); return f ? f.async("string") : Promise.resolve(""); };
  const wb = await read("xl/workbook.xml");
  if (!wb) throw new Error("This is not an Excel workbook (.xlsx or .xlsm).");
  const rid = attr((/<sheet\b([^>]*)>/.exec(wb) || [])[1] || "", "r:id");
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  const tgt = (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`).exec(wbRels) || [""])[0];
  let sheetPath = attr(tgt, "Target") || "worksheets/sheet1.xml";
  sheetPath = sheetPath.startsWith("/") ? sheetPath.slice(1) : "xl/" + sheetPath;
  const ss = [];
  { const x = await read("xl/sharedStrings.xml"); const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(x))) ss.push(texts(m[1])); }
  const rels = {};
  { const x = await read(sheetPath.replace(/([^/]+)$/, "_rels/$1.rels")); const re = /<Relationship\b([^>]*)>/g; let m;
    while ((m = re.exec(x))) { const id = attr(m[1], "Id"), t = attr(m[1], "Target"); if (id && t) rels[id] = dec(t); } }
  const sheet = await read(sheetPath);
  const links = {};   // row number → first hyperlink in that row
  { const re = /<hyperlink\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(sheet))) { const ref = (attr(m[1], "ref") || "").split(":")[0], id = attr(m[1], "r:id");
      if (ref && id && rels[id] && !links[rowOf(ref)]) links[rowOf(ref)] = rels[id]; } }
  const val = (a, body) => {
    const t = attr(a, "t");
    if (t === "inlineStr") return texts(body || "");
    const v = /<v>([\s\S]*?)<\/v>/.exec(body || ""); if (!v) return "";
    return t === "s" ? (ss[+v[1]] || "") : dec(v[1]);
  };
  const HEAD = { n: /^(doc(ument)?\.?\s*(no\.?|num(ber)?|#)|number)$/i, r: /^rev(ision)?\.?$/i, t: /^(title|description|document title)$/i,
    s: /^status$/i, u: /^(url|link|hyperlink|path)$/i, f: /^(file\s*name|file|name)$/i };
  let cols = null; const out = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g, cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = rowRe.exec(sheet))) {
    const rn = +attr(m[1], "r"), cells = {};
    let c; cellRe.lastIndex = 0;
    while ((c = cellRe.exec(m[2]))) { const ref = attr(c[1], "r"); if (ref) cells[colOf(ref)] = val(c[1], c[2]).trim(); }
    if (!cols) {
      const found = {};
      for (const [col, v] of Object.entries(cells)) for (const [k, re] of Object.entries(HEAD)) if (!found[k] && re.test(v)) found[k] = col;
      if (found.n && (found.r || found.t)) cols = found;
      continue;
    }
    const get = k => (cols[k] ? cells[cols[k]] || "" : "");
    let u = links[rn] || ""; if (!/^https?:/i.test(u)) u = /^https?:/i.test(get("u")) ? get("u") : "";
    let f = get("f");
    if (!f && u) { try { f = decodeURIComponent(new URL(u).pathname.split("/").pop()); } catch (_) {} }
    if (!f && /\.\w{2,4}$/.test(cells.A || "")) f = cells.A;
    const n = get("n");
    if (!n && !f) continue;
    out.push([n, get("r"), get("t"), get("s"), f, u]);
  }
  if (!cols) throw new Error("Could not find the column headings. The first rows need headings such as Doc Number, Rev and Title.");
  return out;
}
