#!/usr/bin/env node
// Render a Fenix EFB Markdown document (same dialect as efb-preview.html) to a
// printable, black-and-white PDF using headless Chrome/Chromium.
//
//   node efb-pdf.mjs sop.md                    -> sop.pdf
//   node efb-pdf.mjs sop.md -o out.pdf --aircraft A321 --engine IaeV2500
//
// No npm dependencies. Needs Chrome, Chromium, Brave or Edge (set CHROME=/path to override).
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ---------------- CLI ---------------- */
const USAGE = `Usage: node efb-pdf.mjs <file.md> [options]

Options:
  -o, --output <file.pdf>   Output file (default: <file>.pdf next to the input)
  --aircraft <A319|A320|A321>   Value of aircraft_type (default A320)
  --engine <Cfm56|IaeV2500>     Value of engine_type (default Cfm56)
  --paper <A4|Letter>       Paper size (default A4)
  --columns <1|2>           Number of text columns (default 2)
  --check-wraps             Exit with an error if any line other than a note wraps
                            (checklist items, labels, IF and section titles, headings)
  --html                    Also write the intermediate .html (for debugging)
  -h, --help                Show this help`;

const args = process.argv.slice(2);
const opt = { aircraft: "A320", engine: "Cfm56", paper: "A4", columns: 2, checkWraps: false, html: false, output: null, input: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => { if (i + 1 >= args.length) die(`${a} needs a value.\n\n${USAGE}`); return args[++i]; };
  if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  else if (a === "-o" || a === "--output") opt.output = next();
  else if (a === "--aircraft") opt.aircraft = next();
  else if (a === "--engine") opt.engine = next();
  else if (a === "--paper") opt.paper = next();
  else if (a === "--columns") opt.columns = Number(next());
  else if (a === "--html") opt.html = true;
  else if (a === "--check-wraps") opt.checkWraps = true;
  else if (a.startsWith("-")) die(`Unknown option ${a}\n\n${USAGE}`);
  else if (!opt.input) opt.input = a;
  else die(`Only one input file is supported.\n\n${USAGE}`);
}
if (!opt.input) die(USAGE);
if (!["A319", "A320", "A321"].includes(opt.aircraft)) die(`--aircraft must be A319, A320 or A321.`);
if (!["Cfm56", "IaeV2500"].includes(opt.engine)) die(`--engine must be Cfm56 or IaeV2500.`);
if (![1, 2].includes(opt.columns)) die(`--columns must be 1 or 2.`);
if (!/^(a4|letter)$/i.test(opt.paper)) die(`--paper must be A4 or Letter.`);

function die(msg) { console.error(msg); process.exit(1); }

const inputAbs = path.resolve(opt.input);
if (!existsSync(inputAbs)) die(`File not found: ${opt.input}`);
const ROOT = path.dirname(inputAbs); // includes and absolute (/...) paths resolve from here
const DOC = path.basename(inputAbs);
const outPdf = path.resolve(opt.output || inputAbs.replace(/\.md$/i, "") + ".pdf");

/* ---------------- state & helpers (mirrors efb-preview.html) ---------------- */
const VARS = ["aircraft_type", "engine_type"];
const COLORS = { amber: "c-amber", caution: "c-amber", red: "c-red", warning: "c-red", green: "c-green", cyan: "c-cyan", info: "c-cyan", center: "center" };
const S = { vars: { aircraft_type: opt.aircraft, engine_type: opt.engine }, problems: [], ids: new Set() };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dirname = (p) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
function normPath(p) { const out = []; for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return out.join("/"); }
const joinPath = (dir, rel) => normPath((dir ? dir + "/" : "") + rel);
function cleanTarget(t) { t = t.trim(); if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1); try { t = decodeURIComponent(t); } catch { /* keep raw */ } return t; }
const isExternal = (t) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//");
const resolveFromDoc = (t) => (t.startsWith("/") ? normPath(t.slice(1)) : joinPath(dirname(DOC), t));
const readRel = (p) => readFileSync(path.join(ROOT, ...normPath(p).split("/")), "utf8");
function problem(n, msg, level = "warn") {
  if (S.problems.some((p) => p.n === n && p.msg === msg)) return;
  S.problems.push({ n, msg, level });
}
const plain = (html) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));

/* ---------------- template ({{ }}) ---------------- */
function evalCond(expr, where) {
  return expr.split("||").some((part) => part.split("&&").every((term) => {
    const m = term.trim().match(/^([A-Za-z_][\w]*)\s*(==|!=)\s*"([^"]*)"$/);
    if (!m) throw new Error(`${where}: can't understand the condition "${term.trim()}". Use e.g. aircraft_type == "A320" (values in double quotes).`);
    if (!VARS.includes(m[1])) throw new Error(`${where}: unknown variable "${m[1]}". Valid variables: ${VARS.join(", ")}.`);
    const eq = S.vars[m[1]] === m[3];
    return m[2] === "==" ? eq : !eq;
  }));
}
function rebaseImages(text, incPath) {
  const dir = dirname(incPath);
  return text.replace(/!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)\)/g, (m, alt, t) => {
    const c = cleanTarget(t);
    if (isExternal(c) || c.startsWith("/")) return m;
    return `![${alt}](</${joinPath(dir, c)}>)`;
  });
}
function expand(text, p, depth) {
  text = text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
  text = text.replace(/^[ \t]*(\{\{(?:(?!\}\})[^\n])*\}\})[ \t]*$/gm, "$1\u0001");
  const re = /\{\{([\s\S]*?)\}\}\u0001?\n?/g;
  let out = "", last = 0, m;
  const stack = [];
  const active = () => stack.every((s) => s.active);
  while ((m = re.exec(text))) {
    if (active()) out += text.slice(last, m.index);
    last = re.lastIndex;
    const tagOnly = m[0].includes("\u0001");
    if (!tagOnly && m[0].endsWith("\n")) last--;
    const tag = m[1].trim();
    const where = `${p}, line ${text.slice(0, m.index).split("\n").length}`;
    let mm;
    if ((mm = tag.match(/^if\s+([\s\S]+)$/))) stack.push({ active: evalCond(mm[1], where), elsed: false });
    else if (tag === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new Error(`${where}: {{ else }} without a matching {{ if }}.`);
      if (top.elsed) throw new Error(`${where}: more than one {{ else }} in the same {{ if }}.`);
      top.active = !top.active; top.elsed = true;
    } else if (tag === "end") {
      if (!stack.length) throw new Error(`${where}: {{ end }} without a matching {{ if }}.`);
      stack.pop();
    } else if ((mm = tag.match(/^include\s+"([^"]+)"$/))) {
      if (active()) {
        if (depth > 8) throw new Error(`${where}: includes are nested too deeply (loop?).`);
        const incPath = normPath(mm[1]);
        let inc;
        try { inc = readRel(incPath); } catch (e) { throw new Error(`${where}: could not read included file "${mm[1]}". ${e.message}`); }
        inc = rebaseImages(expand(inc, incPath, depth + 1), incPath);
        out += inc.endsWith("\n") || !tagOnly ? inc : inc + "\n";
      }
    } else if (/^[A-Za-z_]\w*$/.test(tag)) {
      if (!VARS.includes(tag)) throw new Error(`${where}: unknown variable "${tag}". Valid variables: ${VARS.join(", ")}.`);
      if (active()) out += S.vars[tag];
    } else throw new Error(`${where}: can't understand "{{ ${tag} }}".`);
  }
  if (active()) out += text.slice(last);
  if (stack.length) throw new Error(`${p}: an {{ if }} is missing its {{ end }}.`);
  return out;
}

/* ---------------- block parser (::: blocks) ---------------- */
const OPEN_RE = /^:::\s*([a-z][a-z0-9-]*)(?:\s+(.*))?$/;
const FENCE_RE = /^(```|~~~)/;
function dedent(lines) {
  let min = Infinity;
  for (const l of lines) if (l.t.trim()) min = Math.min(min, l.t.match(/^ */)[0].length);
  if (!isFinite(min) || !min) return lines;
  return lines.map((l) => ({ t: l.t.slice(Math.min(min, l.t.match(/^ */)[0].length)), n: l.n }));
}
function parseBlocks(lines) {
  const nodes = []; let buf = [];
  const flush = () => { if (buf.length) { nodes.push({ type: "md", lines: buf }); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], tr = L.t.trim();
    const fm = tr.match(FENCE_RE);
    if (fm) {
      buf.push(L); i++;
      while (i < lines.length && !lines[i].t.trim().startsWith(fm[1])) { buf.push(lines[i]); i++; }
      if (i < lines.length) buf.push(lines[i]);
      continue;
    }
    if (tr.startsWith(":::")) {
      if (tr === ":::") { problem(L.n, "Closing ::: without a matching block."); continue; }
      const m = tr.match(OPEN_RE);
      if (!m) { problem(L.n, `"${tr}" is not a valid block opener (block names are lowercase).`); buf.push(L); continue; }
      flush();
      const j = findClose(lines, i, m[1]);
      nodes.push(makeNode(m[1], (m[2] || "").trim(), dedent(lines.slice(i + 1, j)), L.n));
      i = j;
      continue;
    }
    buf.push(L);
  }
  flush();
  return nodes;
}
function findClose(lines, i, name) {
  let d = 1, j = i + 1;
  for (; j < lines.length; j++) {
    const t = lines[j].t.trim(), f = t.match(FENCE_RE);
    if (f) { j++; while (j < lines.length && !lines[j].t.trim().startsWith(f[1])) j++; continue; }
    if (t === ":::") { if (--d === 0) break; } else if (OPEN_RE.test(t)) d++;
  }
  if (j >= lines.length) problem(lines[i].n, `"::: ${name}" is never closed with its own ::: line.`);
  return j;
}
function makeNode(name, a, body, n) {
  switch (name) {
    case "collapse":
    case "if": {
      let title = a;
      const om = a.match(/^open(?:\s+(.*))?$/);
      if (om) title = (om[1] || "").trim();
      if (!title) problem(n, `"::: ${name}" has no title.`);
      return { type: name, title, children: parseBlocks(body), n };
    }
    case "normal-checklist":
    case "checklist":
      return { type: name, items: parseItems(body), n };
    case "checklist-table":
      return { type: name, lines: body, n };
    default:
      problem(n, `Unknown block "::: ${name}". Valid: collapse, normal-checklist, checklist, if, checklist-table.`);
      return { type: "unknown", children: parseBlocks(body), n };
  }
}
function splitItem(text, n) {
  if (/\.{6,}/.test(text)) problem(n, `More than five dots in "${text.trim()}". Use exactly five: ITEM ..... RESPONSE.`);
  const idx = text.indexOf(".....");
  if (idx < 0) {
    if (/(^|\s)\.{2,4}(\s|$)/.test(text)) problem(n, `"${text.trim()}" has too few dots. Use exactly five, or it is shown as a label.`);
    return null;
  }
  const name = text.slice(0, idx).trim(), resp = text.slice(idx).replace(/^\.+/, "").trim();
  if (!name || !resp) problem(n, `"${text.trim()}" is missing the item or the response.`);
  return { name, resp };
}
function parseItems(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], t = L.t.trim();
    if (!t) { items.push({ gap: true }); continue; }
    if (t.startsWith(":::")) {
      if (t === ":::") { problem(L.n, "Closing ::: without a matching block."); continue; }
      const m = t.match(OPEN_RE);
      if (!m) { problem(L.n, `"${t}" is not a valid block opener (block names are lowercase).`); continue; }
      const j = findClose(lines, i, m[1]);
      items.push({ block: makeNode(m[1], (m[2] || "").trim(), dedent(lines.slice(i + 1, j)), L.n) });
      i = j;
      continue;
    }
    const it = splitItem(t, L.n);
    items.push(it ? { ...it, n: L.n } : { label: t, n: L.n });
  }
  return items;
}

/* ---------------- markdown ---------------- */
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isBlank = (s) => !s.trim();
function isTableSep(s) { return s !== undefined && s.includes("-") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s); }
function splitRow(s) {
  s = s.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function attrs(s) {
  const m = s.match(/\s*\{((?:\s*[.#][\w-]+)+)\s*\}\s*$/);
  if (!m) return { text: s, cls: [], id: null };
  const cls = []; let id = null;
  for (const tok of m[1].trim().split(/\s+/)) {
    if (tok[0] === "#") id = tok.slice(1);
    else if (COLORS[tok.slice(1)]) cls.push(COLORS[tok.slice(1)]);
    else problem(null, `Unknown style "{${tok}}". Use .amber .caution .red .warning .green .cyan .info or .center.`);
  }
  return { text: s.slice(0, m.index), cls, id };
}
function startsBlock(l, next) {
  return FENCE_RE.test(l.trim()) || /^\s{0,3}#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l) || (l.includes("|") && isTableSep(next));
}
function slug(text) { return plain(inline(text)).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-"); }
function uniqueId(id) { let u = id, k = 1; while (S.ids.has(u)) u = `${id}-${k++}`; S.ids.add(u); return u; }

function mdBlocks(lines, tight, nums) { // nums: source line numbers, for top-level blocks
  let html = "", i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = line.trim().match(FENCE_RE))) {
      const code = []; i++;
      while (i < n && !lines[i].trim().startsWith(m[1])) { code.push(lines[i]); i++; }
      i++;
      html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      continue;
    }
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      const lvl = m[1].length;
      const a = attrs(m[2].replace(/\s+#+\s*$/, ""));
      const text = a.text.trim();
      const id = uniqueId(a.id || slug(text));
      html += `<h${lvl}${nums ? ` data-line="${nums[i]}"` : ""} id="${esc(id)}"${a.cls.length ? ` class="${a.cls.join(" ")}"` : ""}>${inline(text)}</h${lvl}>`;
      i++;
      continue;
    }
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const head = splitRow(line), aligns = splitRow(lines[i + 1]).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const rows = [];
      while (i < n && !isBlank(lines[i]) && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i++; }
      const al = (k) => aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
      html += `<table><thead><tr>${head.map((c, k) => `<th${al(k)}>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] || "")}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < n && !isBlank(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      html += `<blockquote>${mdBlocks(q)}</blockquote>`;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += "<hr>"; i++; continue; }
    if (LIST_RE.test(line)) { const r = parseList(lines, i); html += r.html; i = r.i; continue; }
    const para = [];
    while (i < n && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) { para.push(lines[i]); i++; }
    html += renderPara(para, tight);
  }
  return html;
}
function renderPara(para, tight) {
  const a = attrs(para[para.length - 1]);
  para = para.slice(0, -1).concat(a.text);
  const text = para.map((l, k) => k < para.length - 1 && / {2,}$/.test(l) ? l.trim() + "<br>" : l.trim()).join(" ");
  const body = inline(text);
  if (tight && !a.cls.length && !a.id) return body;
  return `<p${a.id ? ` id="${esc(uniqueId(a.id))}"` : ""}${a.cls.length ? ` class="${a.cls.join(" ")}"` : ""}>${body}</p>`;
}
function parseList(lines, i) {
  const first = lines[i].match(LIST_RE);
  const base = first[1].length, ordered = /\d/.test(first[2]), start = ordered ? parseInt(first[2], 10) : 1;
  const items = []; let cur = null, loose = false;
  while (i < lines.length) {
    const l = lines[i], m = l.match(LIST_RE);
    if (m && m[1].length === base && /\d/.test(m[2]) === ordered) { cur = { lines: [m[3]] }; items.push(cur); i++; continue; }
    if (m && m[1].length < base) break;
    if (isBlank(l)) {
      let k = i + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length) {
        const nl = lines[k], nm = nl.match(LIST_RE), ind = nl.match(/^\s*/)[0].length;
        if (ind > base) { cur.lines.push(""); i = k; continue; }
        if (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered) { loose = true; i = k; continue; }
      }
      break;
    }
    const ind = l.match(/^\s*/)[0].length;
    if (ind > base) { cur.lines.push(l.slice(Math.min(ind, base + 4))); i++; continue; }
    if (!startsBlock(l, lines[i + 1])) { cur.lines.push(l.trim()); i++; continue; }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>`;
  for (const it of items) html += `<li>${mdBlocks(it.lines, !(loose || it.lines.includes("")))}</li>`;
  return { html: html + `</${tag}>`, i };
}
function inline(src) {
  const st = [];
  const P = (h) => { st.push(h); return `\u0000${st.length - 1}\u0000`; };
  let s = String(src);
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, a, c) => P(`<code>${esc(c.trim())}</code>`));
  s = s.replace(/<br\s*\/?>/gi, () => P("<br>"));
  s = s.replace(/!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)\)/g, (m, alt, t) => P(imgHtml(alt, t)));
  s = s.replace(/\[([^\]]+)\]\((<[^>]*>|[^)\s]+)\)/g, (m, txt, t) => P(linkHtml(txt, t)));
  s = s.replace(/\[([^\]]+)\]\{\s*\.([\w-]+)\s*\}/g, (m, txt, c) => P(`<span class="${COLORS[c] || ""}">${inline(txt)}</span>`));
  s = esc(s);
  s = s.replace(/\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=[^\s_])([\s\S]*?[^\s_])__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, "<mark>$1</mark>");
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (m, k) => st[+k]);
  return s;
}
function imgHtml(alt, t) {
  const c = cleanTarget(t);
  if (isExternal(c)) { problem(null, `Images from the internet are not included: ${c}`, "info"); return `<span class="img-alt">[${esc(alt || "image")}]</span>`; }
  const file = path.join(ROOT, ...resolveFromDoc(c).split("/"));
  if (!existsSync(file)) { problem(null, `Image not found: ${resolveFromDoc(c)}`); return `<span class="img-alt">[${esc(alt || c)}]</span>`; }
  return `<img src="${esc(pathToFileURL(file).href)}" alt="${esc(alt)}">`;
}
function linkHtml(txt, t) {
  const raw = t.replace(/^<|>$/g, "");
  if (raw.startsWith("#")) return `<a href="#${esc(raw.slice(1))}">${inline(txt)}</a>`;
  return inline(txt); // links to other documents / websites are plain text on paper
}

/* ---------------- print rendering ---------------- */
const isNote = (t) => /^(_[^_][\s\S]*_|\*[^*][\s\S]*\*)$/.test(t.trim());

function renderNodes(nodes, depth) {
  return nodes.map((nd) => {
    if (nd.type === "md") return mdBlocks(nd.lines.map((l) => l.t), false, nd.lines.map((l) => l.n));
    if (nd.type === "collapse") return renderSection(nd, depth);
    if (nd.type === "if") return renderBranch(nd, depth + 1);
    if (nd.type === "normal-checklist" || nd.type === "checklist") return renderChecklist(nd, depth);
    if (nd.type === "checklist-table") return renderClTable(nd);
    return renderNodes(nd.children, depth);
  }).join("");
}
// Keep-together rules for section titles (see .keep in the CSS):
//  - a title always starts its column with at least KEEP_ROWS rows of content under it;
//  - a section of at most KEEP_WHOLE rows is never split at all.
const KEEP_ROWS = 6, KEEP_WHOLE = 12;
function renderSection(nd, depth) {
  const title = `<h2 class="sec-title"${L(nd)}>${inline(nd.title)}</h2>`;
  const [first, ...others] = nd.children.filter((c) => c.type !== "md" || c.lines.some((l) => l.t.trim()));
  const isCl = first && (first.type === "normal-checklist" || first.type === "checklist");
  const total = isCl ? first.items.reduce((n, it) => n + rowsOf(it), 0) : Infinity;
  let inner;
  if (isCl && !(others.length === 0 && total <= KEEP_WHOLE)) inner = renderChecklist(first, depth, title) + renderNodes(others, depth);
  else inner = `<div class="keep">${title}${first ? renderNodes([first], depth) : ""}</div>${renderNodes(others, depth)}`;
  return `<section class="sec">${inner}</section>`;
}
// Approximate printed height of a checklist entry, in item rows.
function rowsOf(it) {
  if (it.gap) return 0;
  if (it.block) return it.block.type === "if" ? 1 + (it.block.children || []).reduce((n, c) => n + (c.items ? c.items.reduce((m, x) => m + rowsOf(x), 0) : 1), 0) : 2;
  return it.label && isNote(it.label) ? Math.ceil(it.label.length / 60) : 1;
}
function renderBranch(nd, depth) {
  return `<div class="br ${depth > 1 ? "lvl2" : "lvl1"}"><div class="br-head"${L(nd)}><span class="br-mark"></span><span>${inline(nd.title)}</span></div>` +
    `<div class="br-body">${renderNodes(nd.children, depth)}</div></div>`;
}
const L = (x) => (x && x.n ? ` data-line="${x.n}"` : "");
const itemHtml = (it, cls = "") => `<div class="item${cls}"${L(it)}><span class="box"></span><span class="i-name">${inline(it.name)}</span><span class="i-dots"></span><span class="i-resp">${inline(it.resp)}</span></div>`;
function renderChecklist(nd, depth, lead) {
  // Group a label with the items that follow it so a heading never ends up alone at the bottom of a page.
  const groups = []; let g = null;
  const start = (label, n) => { g = { label, n, rows: [], size: label ? 1 : 0 }; groups.push(g); };
  for (const it of nd.items) {
    if (it.gap) { if (g && g.rows.length) g = null; continue; }
    if (it.label && !isNote(it.label)) { start(it.label, it.n); continue; }
    if (!g) start(null);
    g.size += rowsOf(it);
    if (it.block) g.rows.push(renderNodes([it.block], depth));
    else if (it.label) g.rows.push(`<div class="note">${inline(it.label)}</div>`);
    else g.rows.push(itemHtml(it));
  }
  const grpHtml = (gr) => `<div class="grp">${gr.label ? `<div class="cl-label"${L(gr)}>${inline(gr.label)}</div>` : ""}${gr.rows.join("")}</div>`;
  let body = groups.map(grpHtml).join("");
  if (lead) { // pull leading groups in with the section title until there are enough rows
    let k = 0, rows = 0;
    while (k < groups.length && rows < KEEP_ROWS) rows += groups[k++].size;
    body = `<div class="keep">${lead}${groups.slice(0, k).map(grpHtml).join("")}</div>${groups.slice(k).map(grpHtml).join("")}`;
  }
  return `<div class="cl ${nd.type === "normal-checklist" ? "normal" : "eqrh"}">${body}</div>`;
}
function renderClTable(nd) {
  const rows = nd.lines.filter((l) => l.t.trim());
  if (rows.length < 2 || !isTableSep(rows[1].t)) {
    problem(nd.n, "::: checklist-table must contain a Markdown table (header row, then a |---| line).");
    return mdBlocks(nd.lines.map((l) => l.t));
  }
  const head = splitRow(rows[0].t);
  const body = rows.slice(2).map((r) => {
    const cells = splitRow(r.t);
    return `<tr>${head.map((_, ci) => {
      const c = cells[ci] || "";
      const it = c.includes(".....") ? splitItem(c, r.n) : null;
      return `<td>${it ? itemHtml({ ...it, n: r.n }, " table-item") : inline(c)}</td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<table class="cltable"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------------- build ---------------- */
let expanded;
try { expanded = expand(readFileSync(inputAbs, "utf8"), DOC, 0); }
catch (e) { die(`Could not open ${DOC}: ${e.message}`); }

const lines = expanded.split("\n").map((t, i) => ({ t: t.replace(/\t/g, "    "), n: i + 1 }));
const body = renderNodes(parseBlocks(lines), 0);
const title = (body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, DOC.replace(/\.md$/i, "")])[1];
const TITLE = plain(title);
const cssStr = (v) => String(v).replace(/["\\\n]/g, (c) => (c === "\n" ? " " : "\\" + c));

// Page margins (top, left/right, bottom) in mm; also used to measure the column width for --check-wraps.
const MARGIN = opt.columns === 2 ? [13, 11, 14] : [15, 14, 16];
const PAGE_WIDTH_MM = opt.paper.toLowerCase() === "letter" ? 215.9 : 210;
const CSS = String.raw`
@page {
  size: ${opt.paper.toLowerCase() === "letter" ? "letter" : "A4"};
  margin: ${MARGIN.map((m) => m + "mm").join(" ")};
  @top-left { content: "${cssStr(TITLE)}"; font: 600 8pt Arial, sans-serif; }
  @top-right { content: "${cssStr(opt.aircraft)} · ${opt.engine === "Cfm56" ? "CFM56" : "IAE V2500"}"; font: 8pt Arial, sans-serif; }
  @bottom-left { content: "Printed ${new Date().toISOString().slice(0, 10)}"; font: 7.5pt Arial, sans-serif; color: #444; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Arial, sans-serif; }
}
:root { --font: "Inter", "Roboto", "Helvetica Neue", Arial, "Liberation Sans", sans-serif; --mono: "DejaVu Sans Mono", Consolas, monospace; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; background: #fff; font: 9.5pt/1.35 var(--font); }
h1, h2, h3, h4, h5, h6 { font-weight: 700; margin: 12pt 0 5pt; line-height: 1.2; break-after: avoid; }
body > h1:first-child { margin-top: 0; font-size: 18pt; letter-spacing: .02em; border-bottom: 2pt solid #000; padding-bottom: 4pt; }
h1 { font-size: 15pt; } h2 { font-size: 12.5pt; } h3 { font-size: 11pt; } h4, h5, h6 { font-size: 10pt; }
p { margin: 5pt 0; orphans: 2; widows: 2; }
a { color: inherit; text-decoration: underline; }
code { font-family: var(--mono); font-size: 8.5pt; border: .5pt solid #888; padding: 0 2pt; border-radius: 2pt; }
pre { border: .75pt solid #000; padding: 6pt 8pt; white-space: pre-wrap; break-inside: avoid; }
pre code { border: 0; padding: 0; }
blockquote { margin: 6pt 0; padding: 1pt 0 1pt 9pt; border-left: 2.5pt solid #000; }
ul, ol { margin: 4pt 0; padding-left: 18pt; }
mark { background: none; color: inherit; border-bottom: 1.5pt solid #000; font-weight: 600; }
hr { border: 0; border-top: .75pt solid #000; margin: 10pt 0; }
table { border-collapse: collapse; margin: 8pt 0; width: 100%; font-size: 9pt; }
th, td { border: .75pt solid #000; padding: 3pt 6pt; vertical-align: top; text-align: left; }
th { font-weight: 700; background: #e6e6e6; }
tr { break-inside: avoid; }
img { max-width: 100%; break-inside: avoid; }
.img-alt { font-style: italic; }
.center { text-align: center; }

/* "colours" in black and white */
.c-red, .c-amber { font-weight: 700; }
p.c-red, h1.c-red, h2.c-red, h3.c-red, h4.c-red { border: 2pt solid #000; padding: 4pt 7pt; }
p.c-amber, h1.c-amber, h2.c-amber, h3.c-amber, h4.c-amber { border: 1pt dashed #000; padding: 4pt 7pt; }
span.c-red { text-decoration: underline; text-decoration-thickness: 1.5pt; text-transform: uppercase; }
span.c-amber { text-decoration: underline; text-decoration-style: dashed; }
.c-green, .c-cyan { color: #000; }

/* collapsible section -> titled section, always expanded */
.sec { margin: 0 0 12pt; }
.keep { break-inside: avoid; }
.keep > .grp:last-child { margin-bottom: 5pt; }

/* two-column layout */
.cols { column-count: ${opt.columns}; column-gap: 8mm; column-rule: .5pt solid #999; column-fill: auto; }
.cols > :first-child, .cols > .sec:first-child .sec-title { margin-top: 0; }
${opt.columns === 2 ? `body { font-size: 8.5pt; }
.cl-label, .note { font-size: 7.5pt; }
.sec-title { font-size: 10pt; }
.cltable, table { font-size: 8pt; }` : ""}
.sec-title { margin: 0 0 5pt; padding: 3pt 7pt; font-size: 11pt; letter-spacing: .05em; background: #000; color: #fff; break-after: avoid; }
.sec-body { padding: 0 2pt; }

/* checklists */
.cl { margin: 4pt 0; }
.grp { break-inside: avoid; margin-bottom: 5pt; }
.grp:last-child { margin-bottom: 0; }
.cl-label { font-weight: 700; font-size: 8.5pt; letter-spacing: .05em; margin: 7pt 0 1pt; padding-bottom: 1pt; border-bottom: .5pt solid #000; }
.grp:first-child > .cl-label { margin-top: 2pt; }
.item { display: flex; align-items: baseline; padding: 1.6pt 0; break-inside: avoid; }
.box { flex: none; width: 7.5pt; height: 7.5pt; border: .9pt solid #000; margin-right: 6pt; transform: translateY(.5pt); }
.i-name { flex: 0 1 auto; }
.i-dots { flex: 1 1 auto; min-width: 14pt; margin: 0 4pt; border-bottom: 1.2pt dotted #000; transform: translateY(-2.5pt); }
.i-resp { flex: 0 1 auto; text-align: right; font-weight: 700; }
.note { font-size: 8.5pt; padding: 0 0 2pt 13.5pt; }
.note em { font-style: italic; }

/* IF branches */
.br { margin: 4pt 0 6pt; break-inside: avoid; }
.br-head { display: flex; align-items: center; gap: 6pt; font-weight: 700; break-after: avoid; }
.br-mark { width: 9pt; height: 9pt; border-radius: 50%; background: #000; flex: none; position: relative; }
.br-mark::after { content: ""; position: absolute; left: 2.25pt; top: 3pt; border-left: 2.25pt solid transparent; border-right: 2.25pt solid transparent; border-top: 3pt solid #fff; }
.br.lvl2 > .br-head .br-mark { border-radius: 1pt; }
.br-body { margin-left: 4.5pt; border-left: 1.2pt solid #000; padding: 2pt 0 7pt 10pt; position: relative; }
.br-body::after { content: ""; position: absolute; left: -1.2pt; bottom: 0; width: 36pt; border-bottom: 1.2pt solid #000; }
.br-body > p { font-size: 9pt; }

/* checklist table */
.cltable td, .cltable th { width: 50%; }
.cltable .item { padding: 0; }
`;

const lead = body.match(/^<h1[^>]*>[\s\S]*?<\/h1>/);
const titleHtml = lead ? lead[0] : `<h1>${title}</h1>`, rest = lead ? body.slice(lead[0].length) : body;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(plain(title))}</title>
<style>${CSS}</style>
</head><body>${titleHtml}<div class="cols">${rest}</div></body></html>`;

for (const p of S.problems) console.error(`${p.level === "warn" ? "warning" : "note"}: ${p.n ? `${DOC}:${p.n}: ` : ""}${p.msg}`);

/* ---------------- print with headless Chrome ---------------- */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "brave", "brave-browser", "microsoft-edge"];
  for (const n of names) { const r = spawnSync("which", [n], { encoding: "utf8" }); if (r.status === 0) return r.stdout.trim(); }
  for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (existsSync(p)) return p;
  return null;
}
// Lays the page out on screen at the printed content width and lists every element (other than notes
// and prose) that takes more than one line. Line numbers are in the document after {{ }} expansion.
const WRAP_CHECK = `<style>@media screen { body { width: ${PAGE_WIDTH_MM - 2 * MARGIN[1]}mm; } }</style><script>
(() => {
  const lines = (e) => { const cs = getComputedStyle(e); return (e.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight); };
  const out = [];
  for (const e of document.querySelectorAll(".item, .cl-label, .br-head, .sec-title, h1, h2, h3, h4, h5, h6")) {
    const parts = e.matches(".item") ? [e.querySelector(".i-name"), e.querySelector(".i-resp")] : e.matches(".br-head") ? [e.lastElementChild] : [e];
    if (parts.some((p) => lines(p) > 1.5)) out.push({ line: e.dataset.line || null, text: e.matches(".item") ? parts.map((p) => p.textContent.trim()).join(" ..... ") : e.textContent.replace(/\\s+/g, " ").trim() });
  }
  document.body.setAttribute("data-wraps", encodeURIComponent(JSON.stringify(out)));
})();
</script>`;

const tmp = mkdtempSync(path.join(tmpdir(), "efb-pdf-"));
const htmlFile = opt.html ? outPdf.replace(/\.pdf$/i, "") + ".html" : path.join(tmp, "doc.html");
writeFileSync(htmlFile, html);
const chrome = findChrome();
if (!chrome) { rmSync(tmp, { recursive: true, force: true }); die("Chrome/Chromium not found. Install one or set CHROME=/path/to/chrome."); }
const chromeRun = (...extra) => spawnSync(chrome, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${path.join(tmp, "profile")}`, "--allow-file-access-from-files",
  ...(process.env.CI ? ["--no-sandbox"] : []), // CI runners usually can't use Chrome's sandbox
  ...extra,
], { encoding: "utf8", maxBuffer: 64 << 20 });

const r = chromeRun("--no-pdf-header-footer", `--print-to-pdf=${outPdf}`, pathToFileURL(htmlFile).href);
let wraps = null;
if (opt.checkWraps && r.status === 0) {
  const checkFile = path.join(tmp, "check.html");
  writeFileSync(checkFile, html.replace("</body>", WRAP_CHECK + "</body>"));
  const c = chromeRun("--dump-dom", pathToFileURL(checkFile).href);
  const m = c.stdout && c.stdout.match(/data-wraps="([^"]*)"/);
  if (!m) { rmSync(tmp, { recursive: true, force: true }); die(`Could not run the line-wrap check.\n${c.stderr || c.error || ""}`); }
  wraps = JSON.parse(decodeURIComponent(m[1]));
}
rmSync(tmp, { recursive: true, force: true });
if (r.status !== 0 || !existsSync(outPdf)) die(`Chrome failed to print the PDF.\n${r.stderr || r.error || ""}`);
console.log(`Wrote ${path.relative(process.cwd(), outPdf) || outPdf}${opt.html ? ` and ${path.relative(process.cwd(), htmlFile)}` : ""}`);
if (wraps && wraps.length) {
  for (const w of wraps) {
    if (process.env.GITHUB_ACTIONS) { // shows up as an annotation on the commit / file in GitHub
      const file = path.relative(process.cwd(), inputAbs).split(path.sep).join("/");
      console.log(`::error file=${file}${w.line ? ",line=" + w.line : ""},title=Line wraps::${w.text.replace(/%/g, "%25").replace(/\r?\n/g, " ")}`);
    }
    console.error(`error: ${DOC}${w.line ? ":" + w.line : ""}: line wraps: ${w.text}`);
  }
  die(`${wraps.length} line${wraps.length > 1 ? "s" : ""} wrap in the ${opt.columns}-column layout. Shorten them, or make explanatory text a note (_italic_).`);
} else if (wraps) console.log("Line-wrap check passed: only notes wrap.");
