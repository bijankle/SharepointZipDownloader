// Background worker: makes the reading copy of one PDF, and builds the batch PDFs, off the page's main thread so the
// page never freezes. pdf.js runs here on an OffscreenCanvas (its parser runs in this same worker, no nested worker),
// pdf-lib rebuilds the PDF. Messages in: {type:"prep"|"batch", id, ...}; out: {type:"progress"|"done"|"error", id, ...}.
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/";
const PDFLIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";
const MAX_PIXELS = 40e6;   // a page bigger than this at the chosen dpi is drawn at a lower dpi (memory guard)
const MAX_SIDE = 16000;    // browsers refuse canvases wider or taller than about 16 000 px

let pdfjs, PL;
const ready = (async () => {
  pdfjs = await import(PDFJS + "build/pdf.min.mjs");
  globalThis.pdfjsWorker = await import(PDFJS + "build/pdf.worker.min.mjs");   // pdf.js then parses in this worker
  PL = await import(PDFLIB);
})();

class CanvasFactory {   // pdf.js asks for scratch canvases; a worker has no document, so OffscreenCanvas
  constructor() {}
  create(w, h) { const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h)); return { canvas, context: canvas.getContext("2d") }; }
  reset(cc, w, h) { cc.canvas.width = Math.max(1, w); cc.canvas.height = Math.max(1, h); }
  destroy(cc) { if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; } cc.canvas = null; cc.context = null; }
}
class FilterFactory {   // the SVG filters pdf.js uses for a few rare effects need a document: drawn without them
  addFilter() { return "none"; } addHCMFilter() { return "none"; } addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; } addHighlightHCMFilter() { return "none"; } destroy() {}
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const say = (id, m, transfer) => postMessage({ id, ...m }, transfer || []);

self.onmessage = async e => {
  const m = e.data;
  try {
    await ready;
    if (m.type === "prep") await prep(m);
    else if (m.type === "batch") await batch(m);
    else if (m.type === "crc") { const u = new Uint8Array(await m.blob.arrayBuffer()); say(m.id, { type: "done", crc: crc32(u) }); }
  } catch (err) {
    say(m.id, { type: "error", error: friendly(err) });
  }
};

function friendly(err) {
  const s = String((err && err.message) || err || "");
  if (/password/i.test(s)) return "This PDF is locked with a password, so it can't be read.";
  if (/Invalid PDF|InvalidPDF|bad XRef|No PDF header|Missing PDF/i.test(s)) return "This file is not a readable PDF (it may be damaged or only partly downloaded).";
  if (/memory|allocation|Array buffer/i.test(s)) return "The computer ran out of memory on this file. Try a lower resolution in Settings.";
  if (/import|fetch|Failed to load|NetworkError/i.test(s)) return "The PDF tools could not be loaded from the internet. Check the connection and reload the page.";
  return "Could not process this file: " + s;
}

// characters the built-in Helvetica font can write; anything else becomes "?" in the hidden text
function cleaner(font) {
  const ok = new Set(font.getCharacterSet());
  return s => { let out = ""; for (const ch of s.normalize("NFKC")) out += ok.has(ch.codePointAt(0)) ? ch : ch === "\t" ? " " : "?"; return out; };
}

async function prep({ id, file, dpi, quality, keepText }) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const crc = crc32(bytes);
  const pdf = await pdfjs.getDocument({
    data: bytes, CanvasFactory, FilterFactory, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: true,
    cMapUrl: PDFJS + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS + "standard_fonts/", verbosity: 0,
  }).promise;
  let title = "";
  try { const md = await pdf.getMetadata(); title = String((md && md.info && md.info.Title) || "").trim(); } catch (_) {}
  const out = await PL.PDFDocument.create();
  const font = await out.embedFont(PL.StandardFonts.Helvetica);
  const clean = cleaner(font);
  const pageBytes = [];
  let textItems = 0, lowered = false;
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    say(id, { type: "progress", page: i, pages: n });
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    let s = dpi / 72;
    s = Math.min(s, Math.sqrt(MAX_PIXELS / (vp1.width * vp1.height)), MAX_SIDE / Math.max(vp1.width, vp1.height));
    if (s < dpi / 72 - 1e-6) lowered = true;
    const vp = page.getViewport({ scale: s });
    const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const jpg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
    canvas.width = 0; canvas.height = 0;
    const img = await out.embedJpg(jpg);
    const p = out.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    pageBytes.push(jpg.length);
    if (keepText) {
      try { textItems += await addText(p, page, vp1, font, clean); } catch (_) { /* text is a bonus: the picture is what counts */ }
    }
    page.cleanup();
  }
  out.setTitle(usefulTitle(title, file.name) || file.name.replace(/\.pdf$/i, ""));
  out.setProducer("PDF prep for Project Library (reading copy)");
  out.setCreator("PDF prep for Project Library");
  let read = await out.save({ useObjectStreams: true }), kept = false;
  await pdf.destroy();
  if (read.length >= file.size) {   // already lighter than a picture copy (a clean CAD export): its own pages go in the batch
    read = new Uint8Array(await file.arrayBuffer()); kept = true;
    pageBytes.fill(Math.ceil(file.size / n));
  }
  say(id, { type: "done", crc, pages: n, title: usefulTitle(title, file.name), pageBytes, textItems, lowered, kept, read: read.buffer }, [read.buffer]);
}

// a PDF's stored title, unless it is one of the meaningless ones CAD and Office tools leave behind
function usefulTitle(t, fileName) {
  t = String(t || "").replace(/^Microsoft (Word|Excel|PowerPoint) - /i, "").replace(/\.(docx?|xlsx?|xlsm|pptx?|dwg|pdf)$/i, "").trim();
  if (!t || /^(untitled|title|document\d*|drawing\d*|sheet\d*|page\d*)$/i.test(t)) return "";
  if (!/\s/.test(t) && /\d/.test(t)) return "";   // a file name or document number, not a title
  if (t.toLowerCase() === fileName.replace(/\.pdf$/i, "").toLowerCase()) return "";
  return t;
}

// the page's words, invisible (text render mode 3) but in the right place and width, so the copy stays searchable
async function addText(p, page, vp1, font, clean) {
  const tc = await page.getTextContent();
  const key = p.node.newFontDictionary(font.name, font.ref);
  const M = pdfjs.Util.transform([1, 0, 0, -1, 0, vp1.height], vp1.transform);   // pdf space → the new page (origin bottom left)
  const ops = [PL.pushGraphicsState(), PL.beginText(), PL.setTextRenderingMode(PL.TextRenderingMode.Invisible), PL.setFontAndSize(key, 1)];
  let count = 0;
  for (const it of tc.items) {
    if (!it || typeof it.str !== "string" || !it.str.trim()) continue;
    const str = clean(it.str);
    const t = pdfjs.Util.transform(M, it.transform);
    const fh = Math.hypot(it.transform[0], it.transform[1]);
    const w = font.widthOfTextAtSize(str, 1);
    let tz = w > 0 && fh > 0 && it.width > 0 ? (100 * it.width) / (w * fh) : 100;
    tz = Math.min(1000, Math.max(5, tz));
    if (!t.every(Number.isFinite)) continue;
    ops.push(PL.setCharacterSqueeze(tz), PL.setTextMatrix(t[0], t[1], t[2], t[3], t[4], t[5]), PL.showText(font.encodeText(str)));
    count++;
  }
  ops.push(PL.endText(), PL.popGraphicsState());
  if (count) p.pushOperators(...ops);
  return count;
}

// one batch: contents page(s) first, then each document's pages (or a part's pages) in order
async function batch({ id, name, items, made }) {
  const out = await PL.PDFDocument.create();
  const font = await out.embedFont(PL.StandardFonts.Helvetica);
  const bold = await out.embedFont(PL.StandardFonts.HelveticaBold);
  const clean = cleaner(font);
  const ROWS = 36, W = 595.28, H = 841.89, L = 40;
  const cpages = Math.max(1, Math.ceil(items.length / ROWS));
  let at = cpages + 1;
  for (const it of items) { it.start = at; it.end = at + (it.to - it.from); at = it.end + 1; }
  const total = at - 1;
  const fit = (s, f, size, max) => { s = clean(s); if (f.widthOfTextAtSize(s, size) <= max) return s; while (s && f.widthOfTextAtSize(s + "...", size) > max) s = s.slice(0, -1); return s + "..."; };
  const grey = PL.rgb(0.35, 0.37, 0.4), ink = PL.rgb(0.1, 0.1, 0.12), line = PL.rgb(0.82, 0.84, 0.87);
  const cols = [L, L + 175, L + 215, L + 300];   // number, rev, pages, title
  for (let cp = 0; cp < cpages; cp++) {
    const p = out.addPage([W, H]);
    let y = H - 56;
    p.drawText(clean(`Contents of ${name}`) + (cpages > 1 ? `  (sheet ${cp + 1} of ${cpages})` : ""), { x: L, y, size: 16, font: bold, color: ink });
    y -= 20;
    p.drawText(clean(`${items.length} document${items.length === 1 ? "" : "s"} or parts, ${total} pages in this file. Made ${made}. Reading copy: most pages are pictures, the originals are kept separately.`), { x: L, y, size: 8.5, font, color: grey, maxWidth: W - 2 * L });
    y -= 28;
    ["Document number", "Rev", "Pages here", "Title"].forEach((h, k) => p.drawText(h, { x: cols[k], y, size: 9, font: bold, color: ink }));
    y -= 6; p.drawLine({ start: { x: L, y }, end: { x: W - L, y }, thickness: 0.8, color: line }); y -= 14;
    for (const it of items.slice(cp * ROWS, cp * ROWS + ROWS)) {
      const pages = it.start === it.end ? `${it.start}` : `${it.start} to ${it.end}`;
      p.drawText(fit(it.number, font, 9, cols[1] - cols[0] - 6), { x: cols[0], y, size: 9, font, color: ink });
      p.drawText(fit(it.rev, font, 9, cols[2] - cols[1] - 6), { x: cols[1], y, size: 9, font, color: ink });
      p.drawText(pages, { x: cols[2], y, size: 9, font, color: ink });
      p.drawText(fit((it.part ? `[${it.part}] ` : "") + (it.title || ""), font, 9, W - L - cols[3]), { x: cols[3], y, size: 9, font, color: ink });
      y -= 5; p.drawLine({ start: { x: L, y }, end: { x: W - L, y }, thickness: 0.4, color: line }); y -= 14;
    }
  }
  let done = 0;
  for (const it of items) {
    const src = await PL.PDFDocument.load(await it.blob.arrayBuffer(), { updateMetadata: false });
    const idx = []; for (let k = it.from; k <= it.to; k++) idx.push(k - 1);
    for (const pg of await out.copyPages(src, idx)) out.addPage(pg);
    say(id, { type: "progress", page: ++done, pages: items.length });
  }
  out.setTitle(name); out.setProducer("PDF prep for Project Library"); out.setCreator("PDF prep for Project Library");
  const bytes = await out.save({ useObjectStreams: true });
  const crc = crc32(bytes);
  say(id, { type: "done", bytes: bytes.buffer, crc, pages: total, starts: items.map(it => [it.start, it.end]) }, [bytes.buffer]);
}
