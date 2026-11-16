import { marked } from "marked";
import DOMPurify from "dompurify";

const WPM = 238;
const THEMES = ["auto", "paper", "sepia", "ink"];
const FONTS = { serif: "var(--font-serif)", sans: "var(--font-sans)", mono: "var(--font-mono)" };
const $ = (s) => document.querySelector(s);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
};

let settings = Object.assign({ theme: "auto", font: "serif", size: 19, measure: 66, leading: 1.7 }, store.get("quire.settings", {}));
let positions = store.get("quire.positions", {});

const site = { name: "", files: [], fileSet: new Set(), folders: new Set(), tree: null, ordered: [] };
let current = null; // { file, words }, { dir } or { missing }
let headings = [];
let loadToken = 0;

marked.setOptions({ gfm: true, breaks: false });
history.scrollRestoration = "manual";

/* ---------- Paths ---------- */

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const dirname = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
const basename = (p) => p.replace(/\/$/, "").split("/").pop();
const stem = (p) => basename(p).replace(/\.(md|markdown|mdown)$/i, "");
const isIndex = (p) => /^(readme|index)\.(md|markdown|mdown)$/i.test(basename(p));
const isMarkdown = (p) => /\.(md|markdown|mdown)$/i.test(p);

function indexOf(dir) {
  return site.files.find((f) => dirname(f) === dir && isIndex(f)) || null;
}

// Works out what a path inside the directory points at, accepting
// links with or without ".md" and links to folders.
function resolve(p) {
  p = p.replace(/^\/+/, "");
  if (p === "" || p === "./") {
    const idx = indexOf("");
    return idx ? { file: idx } : { dir: "" };
  }
  if (site.fileSet.has(p)) return { file: p };
  if (site.fileSet.has(p + ".md")) return { file: p + ".md" };
  const dir = p.endsWith("/") ? p : p + "/";
  if (site.folders.has(dir)) {
    const idx = indexOf(dir);
    return idx ? { file: idx } : { dir };
  }
  return null;
}

function pathFromUrl(u) {
  try { return decodeURIComponent(u.pathname); } catch { return u.pathname; }
}

/* ---------- Markdown ---------- */

function stripFrontMatter(md) {
  const text = md.replace(/\r\n?/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: text, title: null };
  const t = m[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body: text.slice(m[0].length), title: t ? t[1] : null };
}

// GitHub-style heading anchors, so links like file.md#some-heading keep working.
function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

function rewriteLinks(root, file) {
  const base = new URL("/" + encodePath(file), location.origin);
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return;
    }
    if (href.startsWith("#")) { a.dataset.anchor = "1"; return; }
    const u = new URL(href, base);
    const p = pathFromUrl(u).replace(/^\/+/, "");
    const hit = resolve(p);
    if (hit) {
      a.href = "/" + encodePath(hit.file || hit.dir) + u.hash;
      a.dataset.internal = "1";
    } else if (!isMarkdown(p) && /\.[a-z0-9]+$/i.test(p)) {
      a.href = "/raw/" + encodePath(p);
      a.target = "_blank";
    } else {
      a.classList.add("broken");
      a.title = `No file at ${p}`;
      a.removeAttribute("href");
    }
  });
  root.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;
    img.src = "/raw/" + encodePath(pathFromUrl(new URL(src, base)).replace(/^\/+/, ""));
    img.loading = "lazy";
  });
}

function render(md, file) {
  const { body, title } = stripFrontMatter(md);
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(body));
  const root = tpl.content;
  const slug = makeSlugger();

  let docTitle = title;
  let titleId = null;
  const first = root.firstElementChild;
  if (first && first.tagName === "H1") {
    docTitle = docTitle || first.textContent.trim();
    titleId = slug(first.textContent);
    first.remove();
  }
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => { if (!h.id) h.id = slug(h.textContent); });
  root.querySelectorAll("table").forEach((t) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
  rewriteLinks(root, file);
  const words = (root.textContent.match(/\S+/g) || []).length;
  return { root, title: docTitle || stem(file), titleId, words };
}

/* ---------- Tree ---------- */

function buildTree(files) {
  const root = { name: site.name, path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/") + "/";
      site.folders.add(path);
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

const byName = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
const sortedDirs = (node) => [...node.dirs.values()].sort((a, b) => byName.compare(a.name, b.name));
const sortedFiles = (node) => [...node.files].sort((a, b) => (isIndex(b) - isIndex(a)) || byName.compare(basename(a), basename(b)));

// Reading order for previous/next: a folder's own files, then its subfolders.
function flatten(node, out = []) {
  sortedFiles(node).forEach((f) => out.push(f));
  sortedDirs(node).forEach((d) => flatten(d, out));
  return out;
}

function fileLink(f, showDir = false) {
  const a = document.createElement("a");
  a.href = "/" + encodePath(f);
  a.dataset.internal = "1";
  a.dataset.path = f;
  a.title = f;
  const name = document.createElement("span");
  name.className = "min-w-0 truncate";
  name.textContent = stem(f);
  a.appendChild(name);
  if (showDir && dirname(f)) {
    const dir = document.createElement("span");
    dir.className = "ms-auto shrink-0 truncate font-mono text-[0.7rem] opacity-50";
    dir.textContent = dirname(f);
    a.appendChild(dir);
  }
  return a;
}

function renderTree() {
  const ul = $("#tree");
  ul.replaceChildren();
  const q = $("#filter").value.trim().toLowerCase();
  if (q) {
    const hits = site.files.filter((f) => f.toLowerCase().includes(q));
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "px-3 py-2 text-sm text-base-content/60";
      li.textContent = `No files match “${q}”.`;
      ul.appendChild(li);
    }
    hits.forEach((f) => { const li = document.createElement("li"); li.appendChild(fileLink(f, true)); ul.appendChild(li); });
  } else {
    renderNode(site.tree, ul);
  }
  markActive();
}

function renderNode(node, ul) {
  const open = current?.file || current?.dir || "";
  for (const d of sortedDirs(node)) {
    const li = document.createElement("li");
    const details = document.createElement("details");
    details.open = open.startsWith(d.path);
    const summary = document.createElement("summary");
    summary.textContent = d.name;
    const sub = document.createElement("ul");
    renderNode(d, sub);
    details.append(summary, sub);
    li.appendChild(details);
    ul.appendChild(li);
  }
  for (const f of sortedFiles(node)) {
    const li = document.createElement("li");
    li.appendChild(fileLink(f));
    ul.appendChild(li);
  }
}

// Highlights the open file, expands its folders and scrolls the sidebar
// (never the page) so it's in view.
function markActive() {
  document.querySelectorAll("#tree a[data-path]").forEach((a) => {
    a.classList.toggle("menu-active", a.dataset.path === current?.file);
  });
  if (!current?.file) return;
  const el = document.querySelector(`#tree a[data-path="${CSS.escape(current.file)}"]`);
  if (!el) return;
  for (let d = el.closest("details"); d; d = d.parentElement.closest("details")) d.open = true;
  const side = $(".drawer-side");
  const r = el.getBoundingClientRect();
  const b = side.getBoundingClientRect();
  if (b.height && (r.top < b.top || r.bottom > b.bottom)) side.scrollTop += r.top - b.top - b.height / 3;
}

/* ---------- Pages ---------- */

function renderCrumbs(p) {
  const ul = $("#crumbs ul");
  ul.replaceChildren();
  const add = (label, href) => {
    const li = document.createElement("li");
    const el = document.createElement(href ? "a" : "span");
    el.textContent = label;
    if (href) { el.href = href; el.dataset.internal = "1"; }
    li.appendChild(el);
    ul.appendChild(li);
  };
  add(site.name, "/");
  const parts = p.replace(/\/$/, "").split("/").filter(Boolean);
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    add(last ? stem(part) : part, last ? null : "/" + encodePath(parts.slice(0, i + 1).join("/") + "/"));
  });
}

function renderToc() {
  headings = [...$("#doc-body").querySelectorAll("h2, h3, h4")];
  const lists = [$("#toc-inline .toc"), $("#toc-side-list")];
  lists.forEach((list) => {
    list.replaceChildren();
    headings.forEach((h) => {
      const a = document.createElement("a");
      a.href = "#" + h.id;
      a.dataset.anchor = "1";
      a.dataset.target = h.id;
      a.className = "lvl-" + h.tagName[1];
      a.textContent = h.textContent;
      list.appendChild(a);
    });
  });
  const show = headings.length >= 2;
  $("#toc-inline").hidden = !show;
  $("#toc-side").hidden = !show;
}

function renderFooter() {
  const footer = $("#doc-footer");
  footer.replaceChildren();
  if (!current?.file) return;
  const i = site.ordered.indexOf(current.file);
  const make = (f, label, end) => {
    const a = document.createElement("a");
    a.href = "/" + encodePath(f);
    a.dataset.internal = "1";
    a.className = "flex min-w-0 flex-col gap-0.5 rounded-box border border-base-300 px-4 py-3 hover:bg-base-200" + (end ? " text-end sm:col-start-2" : "");
    const small = document.createElement("span");
    small.className = "eyebrow text-base-content/60";
    small.textContent = label;
    const name = document.createElement("span");
    name.className = "truncate font-semibold";
    name.textContent = stem(f) + (isIndex(f) && dirname(f) ? ` · ${basename(dirname(f))}` : "");
    a.append(small, name);
    return a;
  };
  if (i > 0) footer.appendChild(make(site.ordered[i - 1], "Previous", false));
  if (i >= 0 && i < site.ordered.length - 1) footer.appendChild(make(site.ordered[i + 1], "Next", true));
}

function showPage({ title, titleId, eyebrow, path, body }) {
  const h1 = $("#doc-title");
  h1.textContent = title;
  if (titleId) h1.dataset.slug = titleId; else delete h1.dataset.slug;
  $("#doc-eyebrow").textContent = eyebrow;
  $("#doc-path").textContent = path;
  $("#doc-body").replaceChildren(body);
  document.title = `${title} · ${site.name}`;
  renderToc();
  renderFooter();
  markActive();
}

function linkTo(path, label) {
  const a = document.createElement("a");
  a.href = "/" + encodePath(path);
  a.dataset.internal = "1";
  a.textContent = label;
  return a;
}

function folderBody(dir) {
  const node = dir.split("/").filter(Boolean).reduce((n, part) => n?.dirs.get(part), site.tree);
  const ul = document.createElement("ul");
  if (node) {
    sortedDirs(node).forEach((d) => { const li = document.createElement("li"); li.appendChild(linkTo(d.path, d.name + "/")); ul.appendChild(li); });
    sortedFiles(node).forEach((f) => { const li = document.createElement("li"); li.appendChild(linkTo(f, stem(f))); ul.appendChild(li); });
  }
  return ul;
}

function message(text) {
  const frag = document.createDocumentFragment();
  const p = document.createElement("p");
  p.textContent = text;
  const back = document.createElement("p");
  back.appendChild(linkTo("", `Back to ${site.name}`));
  frag.append(p, back);
  return frag;
}

async function route({ restore = false, scrollY = null } = {}) {
  const token = ++loadToken;
  const raw = pathFromUrl(new URL(location.href)).replace(/^\/+/, "");
  const hit = resolve(raw);
  closeDrawer();

  if (!hit) {
    current = { missing: raw };
    renderCrumbs(raw);
    showPage({ title: "Not found", eyebrow: "", path: raw, body: message(`There's no Markdown file at “${raw}” in this folder.`) });
    return finishScroll(0);
  }

  // Use the file's own path as the address, so relative links resolve from it.
  const canonical = "/" + encodePath(hit.file || hit.dir);
  if (canonical !== location.pathname) history.replaceState(history.state, "", canonical + location.hash);

  if (hit.dir !== undefined) {
    current = { dir: hit.dir };
    renderCrumbs(hit.dir);
    showPage({ title: hit.dir ? basename(hit.dir) : site.name, eyebrow: "Folder", path: hit.dir || "./", body: folderBody(hit.dir) });
    return finishScroll(0);
  }

  let md;
  try {
    const res = await fetch("/raw/" + encodePath(hit.file), { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    md = await res.text();
  } catch (err) {
    if (token !== loadToken) return;
    current = { file: hit.file, words: 0 };
    renderCrumbs(hit.file);
    showPage({ title: stem(hit.file), eyebrow: "", path: hit.file, body: message(`Couldn't load this file (${err.message}). Is the server still running?`) });
    return;
  }
  if (token !== loadToken) return;

  const doc = render(md, hit.file);
  current = { file: hit.file, words: doc.words };
  renderCrumbs(hit.file);
  showPage({
    title: doc.title,
    titleId: doc.titleId,
    eyebrow: `${minutes(doc.words)} min read · ${doc.words.toLocaleString("en-GB")} words`,
    path: hit.file,
    body: doc.root
  });

  if (scrollY !== null) finishScroll(scrollY);
  else if (location.hash) scrollToHash(location.hash);
  else if (restore && positions[hit.file] < 0.995) finishScroll(null, positions[hit.file]);
  else finishScroll(0);
}

function finishScroll(y, ratio) {
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: ratio != null ? ratio * max : y, behavior: "instant" });
    update();
  });
}

function scrollToHash(hash) {
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch {}
  const el = document.getElementById(id) || document.querySelector(`#doc-title[data-slug="${CSS.escape(id)}"]`);
  requestAnimationFrame(() => {
    if (el) el.scrollIntoView({ block: "start" }); else window.scrollTo({ top: 0, behavior: "instant" });
    update();
  });
}

function navigate(url) {
  savePosition();
  history.replaceState({ scrollY: window.scrollY }, "");
  history.pushState(null, "", url);
  route();
}

document.addEventListener("click", (e) => {
  const details = $("#settings");
  if (details.open && !details.contains(e.target)) details.open = false;

  const a = e.target.closest("a[data-internal], a[data-anchor]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (a.dataset.anchor) {
    history.replaceState(history.state, "", a.getAttribute("href"));
    scrollToHash(a.getAttribute("href"));
    return;
  }
  const url = new URL(a.href);
  if (url.pathname === location.pathname && url.hash) {
    history.replaceState(history.state, "", url.hash);
    scrollToHash(url.hash);
  } else {
    navigate(url.pathname + url.hash);
  }
});

window.addEventListener("popstate", (e) => {
  route({ scrollY: e.state?.scrollY ?? null });
});

/* ---------- Progress and position ---------- */

function minutes(words) { return Math.max(1, Math.round(words / WPM)); }

let ticking = false;
let saveTimer = null;

function scrollRatio() {
  const max = document.documentElement.scrollHeight - innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 1;
}

function update() {
  const p = scrollRatio();
  $("#read-bar").value = Math.round(p * 1000);
  if (current?.words) {
    const left = Math.max(1, Math.ceil(minutes(current.words) * (1 - p)));
    $("#time-left").textContent = p >= 0.995 ? "Finished" : `${left} min left`;
  } else {
    $("#time-left").textContent = "";
  }
  let active = null;
  for (const h of headings) {
    if (h.getBoundingClientRect().top < innerHeight * 0.3) active = h.id; else break;
  }
  document.querySelectorAll(".toc a").forEach((a) => a.classList.toggle("is-active", a.dataset.target === active));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 400);
}

function savePosition() {
  if (!current?.file) return;
  positions[current.file] = scrollRatio();
  store.set("quire.positions", positions);
}

window.addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; update(); });
}, { passive: true });
window.addEventListener("resize", update);
window.addEventListener("pagehide", savePosition);

/* ---------- Settings ---------- */

function applySettings() {
  if (settings.theme === "auto") delete document.body.dataset.reader;
  else document.body.dataset.reader = settings.theme;
  const s = document.documentElement.style;
  s.setProperty("--reader-font", FONTS[settings.font] || FONTS.serif);
  s.setProperty("--reader-size", settings.size + "px");
  s.setProperty("--reader-measure", settings.measure + "ch");
  s.setProperty("--reader-leading", settings.leading);
  $(`#theme-${settings.theme}`).checked = true;
  $(`#font-${settings.font}`).checked = true;
  $("#size").value = settings.size;
  $("#measure").value = settings.measure;
  $("#leading").value = settings.leading;
  $("#size-out").textContent = settings.size + " px";
  $("#measure-out").textContent = "~" + settings.measure + " characters";
  $("#leading-out").textContent = Number(settings.leading).toFixed(2);
  store.set("quire.settings", settings);
}

function changeSetting(key, value) {
  const p = scrollRatio();
  settings[key] = value;
  applySettings();
  const max = document.documentElement.scrollHeight - innerHeight;
  window.scrollTo({ top: p * max, behavior: "instant" });
}

document.querySelectorAll('input[name="theme"]').forEach((el) => el.addEventListener("change", () => changeSetting("theme", el.value)));
document.querySelectorAll('input[name="font"]').forEach((el) => el.addEventListener("change", () => changeSetting("font", el.value)));
$("#size").addEventListener("input", (e) => changeSetting("size", Number(e.target.value)));
$("#measure").addEventListener("input", (e) => changeSetting("measure", Number(e.target.value)));
$("#leading").addEventListener("input", (e) => changeSetting("leading", Number(e.target.value)));

/* ---------- Sidebar and keys ---------- */

function closeDrawer() { $("#sidebar-toggle").checked = false; }

$("#filter").addEventListener("input", renderTree);
$("#filter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = $("#tree a[data-path]");
    if (first) { $("#filter").value = ""; navigate(first.getAttribute("href")); renderTree(); }
  } else if (e.key === "Escape") {
    $("#filter").value = "";
    renderTree();
    $("#filter").blur();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("input:not([type=radio]):not([type=range]), textarea, [contenteditable]")) return;
  if (e.key === "/") { e.preventDefault(); $("#sidebar-toggle").checked = true; $("#filter").focus(); }
  else if (e.key === "[") { const t = $("#sidebar-toggle"); t.checked = !t.checked; }
  else if (e.key === "+" || e.key === "=") changeSetting("size", Math.min(25, settings.size + 1));
  else if (e.key === "-" || e.key === "_") changeSetting("size", Math.max(15, settings.size - 1));
  else if (e.key === "t") changeSetting("theme", THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]);
  else if (e.key === "Escape") { $("#settings").open = false; closeDrawer(); }
});

/* ---------- Start ---------- */

async function boot() {
  applySettings();
  try {
    const res = await fetch("/api/tree", { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    site.name = data.name;
    site.files = data.files || [];
  } catch (err) {
    $("#doc-title").textContent = "Couldn't list files";
    $("#doc-body").textContent = `The server didn't answer (${err.message}). Start it with "go run ." and reload.`;
    return;
  }
  site.fileSet = new Set(site.files);
  site.tree = buildTree(site.files);
  site.ordered = flatten(site.tree);
  $("#root-name").textContent = site.name + "/";
  $("#tree-count").textContent = `${site.files.length} Markdown ${site.files.length === 1 ? "file" : "files"}`;
  renderTree();
  await route({ restore: true });
}

boot();
