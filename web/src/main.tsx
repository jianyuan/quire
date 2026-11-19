import { render, type ComponentChildren } from "preact";
import { memo } from "preact/compat";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Fzf, byLengthAsc, extendedMatch } from "fzf";
import { fromDropped, fromPicked, type Local } from "./local";

// The Go server lists the folder and serves its files. The static build
// for GitHub Pages has no server, so visitors open files from their own
// disk, and the open file goes in ?p= because Pages serves a single page.
const STATIC = import.meta.env.MODE === "pages";

const WPM = 238;
const THEMES = ["auto", "paper", "sepia", "ink"] as const;
const FONTS = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
};

type Settings = {
  theme: (typeof THEMES)[number];
  font: keyof typeof FONTS;
  size: number;
  measure: number;
  leading: number;
};

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const positions = store.get<Record<string, number>>("quire.positions", {});

type Dir = {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
};

// In the static build, local maps each path to a File from disk and blobs
// holds the object URLs made for images and attachments.
type Site = {
  name: string;
  files: string[];
  fileSet: Set<string>;
  folders: Set<string>;
  tree: Dir;
  ordered: string[];
  fzf: Fzf<string[]>;
  local: Map<string, File> | null;
  blobs: Map<string, string>;
};

type Current = { file?: string; dir?: string; words?: number } | null;
type Heading = { id: string; level: number; text: string };
type Scroll = { y: number } | { ratio: number } | { hash: string };
type Page = {
  current: Current;
  crumbs: string | null;
  title: string;
  titleId?: string | null;
  eyebrow: string;
  path: string;
  doc?: DocumentFragment;
  body?: ComponentChildren;
  headings: Heading[];
  scroll?: Scroll;
};
type RouteOptions = { restore?: boolean; scrollY?: number | null };

let loadToken = 0;

marked.setOptions({ gfm: true, breaks: false });
history.scrollRestoration = "manual";

/* ---------- Paths ---------- */

const encodePath = (p: string) =>
  p.split("/").map(encodeURIComponent).join("/");
const dirname = (p: string) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
const basename = (p: string) => p.replace(/\/$/, "").split("/").pop()!;
const stem = (p: string) => basename(p).replace(/\.(md|markdown|mdown)$/i, "");
const isIndex = (p: string) =>
  /^(readme|index)\.(md|markdown|mdown)$/i.test(basename(p));
const isMarkdown = (p: string) => /\.(md|markdown|mdown)$/i.test(p);

// The reader's address for a file or folder, and the path in an address.
const pageUrl = (p: string) =>
  STATIC
    ? location.pathname + (p ? "?p=" + encodePath(p) : "")
    : "/" + encodePath(p);
const pathOf = (u: URL) =>
  STATIC ? (u.searchParams.get("p") ?? "") : pathFromUrl(u);

// Where the browser can load a file that isn't Markdown, such as an image,
// or null if the static build wasn't given it.
function rawUrl(site: Site, p: string) {
  if (!STATIC) return "/raw/" + encodePath(p);
  const file = site.local!.get(p);
  if (!file) return null;
  if (!site.blobs.has(p)) site.blobs.set(p, URL.createObjectURL(file));
  return site.blobs.get(p)!;
}

async function readFile(site: Site, p: string) {
  if (STATIC) return site.local!.get(p)!.text();
  const res = await fetch("/raw/" + encodePath(p), { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function indexOf(site: Site, dir: string) {
  return site.files.find((f) => dirname(f) === dir && isIndex(f)) || null;
}

// Works out what a path inside the directory points at, accepting
// links with or without ".md" and links to folders.
function resolve(
  site: Site,
  p: string,
): { file: string } | { dir: string } | null {
  p = p.replace(/^\/+/, "");
  if (p === "" || p === "./") {
    const idx =
      indexOf(site, "") || (site.files.length === 1 ? site.files[0] : null);
    return idx ? { file: idx } : { dir: "" };
  }
  if (site.fileSet.has(p)) return { file: p };
  if (site.fileSet.has(p + ".md")) return { file: p + ".md" };
  const dir = p.endsWith("/") ? p : p + "/";
  if (site.folders.has(dir)) {
    const idx = indexOf(site, dir);
    return idx ? { file: idx } : { dir };
  }
  return null;
}

function pathFromUrl(u: URL) {
  try {
    return decodeURIComponent(u.pathname);
  } catch {
    return u.pathname;
  }
}

/* ---------- Markdown ---------- */

function stripFrontMatter(md: string) {
  const text = md.replace(/\r\n?/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: text, title: null };
  const t = m[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body: text.slice(m[0].length), title: t ? t[1] : null };
}

// GitHub-style heading anchors, so links like file.md#some-heading keep working.
function makeSlugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

function rewriteLinks(site: Site, root: DocumentFragment, file: string) {
  const base = new URL("/" + encodePath(file), location.origin);
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href")!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      return;
    }
    if (href.startsWith("#")) {
      a.setAttribute("data-anchor", "1");
      return;
    }
    const u = new URL(href, base);
    const p = pathFromUrl(u).replace(/^\/+/, "");
    const hit = resolve(site, p);
    const raw =
      !hit && !isMarkdown(p) && /\.[a-z0-9]+$/i.test(p)
        ? rawUrl(site, p)
        : null;
    if (hit) {
      a.setAttribute(
        "href",
        pageUrl("file" in hit ? hit.file : hit.dir) + u.hash,
      );
      a.setAttribute("data-internal", "1");
    } else if (raw) {
      a.setAttribute("href", raw);
      a.setAttribute("target", "_blank");
    } else {
      a.classList.add("broken");
      a.setAttribute("title", `No file at ${p}`);
      a.removeAttribute("href");
    }
  });
  root.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src")!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;
    const p = pathFromUrl(new URL(src, base)).replace(/^\/+/, "");
    const url = rawUrl(site, p);
    if (url) img.setAttribute("src", url);
    else {
      img.removeAttribute("src");
      img.setAttribute("title", `No file at ${p}`);
    }
    img.setAttribute("loading", "lazy");
  });
}

function renderMarkdown(site: Site, md: string, file: string) {
  const { body, title } = stripFrontMatter(md);
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(body) as string);
  const root = tpl.content;
  const slug = makeSlugger();

  let docTitle = title;
  let titleId = null;
  const first = root.firstElementChild;
  if (first && first.tagName === "H1") {
    docTitle = docTitle || first.textContent!.trim();
    titleId = slug(first.textContent!);
    first.remove();
  }
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    if (!h.id) h.id = slug(h.textContent!);
  });
  root.querySelectorAll("table").forEach((t) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });
  rewriteLinks(site, root, file);
  const words = (root.textContent!.match(/\S+/g) || []).length;
  const headings = [...root.querySelectorAll("h2, h3, h4")].map((h) => ({
    id: h.id,
    level: Number(h.tagName[1]),
    text: h.textContent!,
  }));
  return { root, title: docTitle || stem(file), titleId, words, headings };
}

/* ---------- Tree ---------- */

function makeSite(
  name: string,
  files: string[],
  local: Map<string, File> | null = null,
): Site {
  const folders = new Set<string>();
  const tree: Dir = { name, path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/") + "/";
      folders.add(path);
      if (!node.dirs.has(parts[i]))
        node.dirs.set(parts[i], {
          name: parts[i],
          path,
          dirs: new Map(),
          files: [],
        });
      node = node.dirs.get(parts[i])!;
    }
    node.files.push(f);
  }
  return {
    name,
    files,
    fileSet: new Set(files),
    folders,
    tree,
    ordered: flatten(tree),
    local,
    blobs: new Map(),
    // Extended syntax, as in fzf: spaces split terms, 'exact, ^prefix, suffix$, !not.
    fzf: new Fzf(files, { match: extendedMatch, tiebreakers: [byLengthAsc] }),
  };
}

const byName = new Intl.Collator("en-GB", {
  numeric: true,
  sensitivity: "base",
});
const sortedDirs = (node: Dir) =>
  [...node.dirs.values()].sort((a, b) => byName.compare(a.name, b.name));
const sortedFiles = (node: Dir) =>
  [...node.files].sort(
    (a, b) =>
      Number(isIndex(b)) - Number(isIndex(a)) ||
      byName.compare(basename(a), basename(b)),
  );

// Reading order for previous/next: a folder's own files, then its subfolders.
function flatten(node: Dir, out: string[] = []) {
  sortedFiles(node).forEach((f) => out.push(f));
  sortedDirs(node).forEach((d) => flatten(d, out));
  return out;
}

// Text, with the characters at the given positions in the path (offset by
// where text starts in it) in <b> so fuzzy matches stand out.
function Hits({
  text,
  offset,
  hits,
}: {
  text: string;
  offset: number;
  hits?: Set<number>;
}) {
  if (!hits) return <>{text}</>;
  return (
    <>
      {[...text].map((c, i) =>
        hits.has(offset + i) ? <b class="text-primary">{c}</b> : c,
      )}
    </>
  );
}

type Line = [number, string, string, string];

function FileLink({
  f,
  active,
  showDir = false,
  lines = [],
  hits,
}: {
  f: string;
  active: boolean;
  showDir?: boolean;
  lines?: Line[];
  hits?: Set<number>;
}) {
  const name = (
    <span class={showDir ? "max-w-full shrink-0 truncate" : "min-w-0 truncate"}>
      <Hits text={stem(f)} offset={dirname(f).length} hits={hits} />
    </span>
  );
  // Search results put the name and folder on one row that fits the sidebar:
  // the name keeps its width and the folder takes what's left.
  return (
    <a
      href={pageUrl(f)}
      data-internal="1"
      data-path={f}
      title={f}
      class={[showDir && "flex flex-wrap max-w-full", active && "menu-active"]
        .filter(Boolean)
        .join(" ")}
    >
      {showDir ? (
        <span class="flex min-w-0 basis-full items-baseline gap-2">
          {name}
          {dirname(f) && (
            <span class="ms-auto min-w-0 truncate font-mono text-[0.7rem] opacity-50">
              <Hits text={dirname(f)} offset={0} hits={hits} />
            </span>
          )}
        </span>
      ) : (
        name
      )}
      {lines.map(([n, before, match, after]) => (
        <span class="basis-full truncate text-xs opacity-60">
          <span class="me-2 font-mono opacity-60">{n}</span>
          {before}
          <mark>{match}</mark>
          {after}
        </span>
      ))}
    </a>
  );
}

// Up to three matching lines in a file, as [line number, before, match, after].
function matchingLines(text: string, re: RegExp) {
  const out: Line[] = [];
  text.split(/\r?\n/).some((line, i) => {
    const m = line.match(re);
    if (m)
      out.push([
        i + 1,
        (m.index! > 30 ? "…" : "") +
          line.slice(Math.max(0, m.index! - 30), m.index).trimStart(),
        m[0],
        line.slice(m.index! + m[0].length, m.index! + m[0].length + 80),
      ]);
    return out.length === 3;
  });
  return out;
}

// Every file's text, for searching contents. The server sends every file in
// one response instead of one request each. A failed load counts as empty
// text, so the search stops waiting.
async function loadTexts(site: Site) {
  const texts = new Map<string, string>();
  if (STATIC) {
    await Promise.all(
      site.files.map(async (f) =>
        texts.set(f, await readFile(site, f).catch(() => "")),
      ),
    );
  } else {
    const all: Record<string, string> = await fetch("/api/texts", {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
    site.files.forEach((f) => texts.set(f, all[f] ?? ""));
  }
  return texts;
}

function TreeNode({ node, file }: { node: Dir; file?: string }) {
  return (
    <>
      {sortedDirs(node).map((d) => (
        <li key={d.path}>
          <details data-dir={d.path}>
            <summary>{d.name}</summary>
            <ul>
              <TreeNode node={d} file={file} />
            </ul>
          </details>
        </li>
      ))}
      {sortedFiles(node).map((f) => (
        <li key={f}>
          <FileLink f={f} active={f === file} />
        </li>
      ))}
    </>
  );
}

const Tree = memo(function Tree({
  site,
  query,
  file,
  open,
}: {
  site: Site;
  query: string;
  file?: string;
  open: string;
}) {
  const ul = useRef<HTMLUListElement>(null);
  const q = query.trim();
  const searching = q !== "";
  // Loaded when a search starts, and dropped when it ends so the next
  // search sees edits made since.
  const [texts, setTexts] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!searching) return;
    let live = true;
    loadTexts(site).then((t) => {
      if (live) setTexts(t);
    });
    return () => {
      live = false;
      setTexts(null);
    };
  }, [searching, site]);

  // Names match fuzzily, best first; contents match the text as typed,
  // ignoring case, like the editors' text search.
  const results = useMemo(() => {
    if (!q) return null;
    const named = site.fzf.find(q);
    const found = new Set(named.map((m) => m.item));
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const byText = site.files
      .filter((f) => !found.has(f))
      .map((f): [string, Line[]] => [f, matchingLines(texts?.get(f) ?? "", re)])
      .filter(([, lines]) => lines.length);
    return { named, byText };
  }, [q, site, texts]);

  // Expands the open file's or folder's folders and scrolls the sidebar
  // (never the page) so the open file is in view.
  useEffect(() => {
    ul.current!.querySelectorAll<HTMLDetailsElement>(
      "details[data-dir]",
    ).forEach((d) => {
      if (open.startsWith(d.dataset.dir!)) d.open = true;
    });
    const el =
      file && ul.current!.querySelector(`a[data-path="${CSS.escape(file)}"]`);
    if (!el) return;
    const side = ul.current!.closest(".drawer-side")!;
    const r = el.getBoundingClientRect();
    const b = side.getBoundingClientRect();
    if (b.height && (r.top < b.top || r.bottom > b.bottom))
      side.scrollTop += r.top - b.top - b.height / 3;
  }, [site, file, open, searching]);

  return (
    <ul id="tree" ref={ul} class="tree menu menu-sm w-full p-0">
      {results ? (
        <>
          {!results.named.length && !results.byText.length && (
            <li class="px-3 py-2 text-sm text-base-content/60">
              {texts ? `No files match “${q}”.` : "Searching…"}
            </li>
          )}
          {results.named.map((m) => (
            <li class="max-w-full">
              <FileLink
                f={m.item}
                active={m.item === file}
                showDir
                hits={m.positions}
              />
            </li>
          ))}
          {results.byText.map(([f, lines]) => (
            <li class="max-w-full">
              <FileLink f={f} active={f === file} showDir lines={lines} />
            </li>
          ))}
        </>
      ) : (
        <TreeNode node={site.tree} file={file} />
      )}
    </ul>
  );
});

/* ---------- Pages ---------- */

function Crumbs({ site, path }: { site: Site; path: string }) {
  const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
  return (
    <>
      <li>
        <a href={pageUrl("")} data-internal="1">
          {site.name}
        </a>
      </li>
      {parts.map((part, i) =>
        i === parts.length - 1 ? (
          <li>
            <span>{stem(part)}</span>
          </li>
        ) : (
          <li>
            <a
              href={pageUrl(parts.slice(0, i + 1).join("/") + "/")}
              data-internal="1"
            >
              {part}
            </a>
          </li>
        ),
      )}
    </>
  );
}

function Toc({
  headings,
  active,
}: {
  headings: Heading[];
  active: string | null;
}) {
  return (
    <>
      {headings.map((h) => (
        <a
          href={"#" + h.id}
          data-anchor="1"
          class={`lvl-${h.level}` + (h.id === active ? " is-active" : "")}
          aria-current={h.id === active ? "location" : undefined}
        >
          {h.text}
        </a>
      ))}
    </>
  );
}

function Footer({ site, file }: { site: Site; file: string }) {
  const i = site.ordered.indexOf(file);
  const link = (f: string, label: string, end: boolean) => (
    <a
      href={pageUrl(f)}
      data-internal="1"
      class={
        "flex min-w-0 flex-col gap-0.5 rounded-box border border-base-300 px-4 py-3 hover:bg-base-200" +
        (end ? " text-end sm:col-start-2" : "")
      }
    >
      <span class="eyebrow text-base-content/60">{label}</span>
      <span class="truncate font-semibold">
        {stem(f) +
          (isIndex(f) && dirname(f) ? ` · ${basename(dirname(f))}` : "")}
      </span>
    </a>
  );
  return (
    <>
      {i > 0 && link(site.ordered[i - 1], "Previous", false)}
      {i >= 0 &&
        i < site.ordered.length - 1 &&
        link(site.ordered[i + 1], "Next", true)}
    </>
  );
}

function FolderList({ site, dir }: { site: Site; dir: string }) {
  const node = dir
    .split("/")
    .filter(Boolean)
    .reduce<Dir | undefined>((n, part) => n?.dirs.get(part), site.tree);
  return (
    <ul>
      {node &&
        sortedDirs(node).map((d) => (
          <li>
            <a href={pageUrl(d.path)} data-internal="1">
              {d.name + "/"}
            </a>
          </li>
        ))}
      {node &&
        sortedFiles(node).map((f) => (
          <li>
            <a href={pageUrl(f)} data-internal="1">
              {stem(f)}
            </a>
          </li>
        ))}
    </ul>
  );
}

function Message({ site, text }: { site: Site; text: string }) {
  return (
    <>
      <p>{text}</p>
      <p>
        <a href={pageUrl("")} data-internal="1">{`Back to ${site.name}`}</a>
      </p>
    </>
  );
}

// The static build (vite build --mode pages) reads files from disk.
function welcome(note?: string): Page {
  const body = (
    <>
      <p>
        Open a Markdown file, or a whole folder of them, to read it with a table
        of contents, reading time and links between files.
      </p>
      <div class="flex flex-wrap gap-2 font-sans">
        <label for="open-file" class="btn btn-primary">
          Open a file
        </label>
        <label for="open-folder" class="btn">
          Open a folder
        </label>
      </div>
      {note && <p class="text-error">{note}</p>}
      <p class="text-base-content/70">
        You can also drop files or a folder anywhere on this page. Quire reads
        them in your browser and doesn't upload them.
      </p>
      <p class="text-base-content/70">
        To read a folder without opening it each time, run the{" "}
        <a href="https://github.com/jianyuan/quire">Quire app</a> on your
        computer.
      </p>
    </>
  );
  return {
    current: null,
    crumbs: null,
    title: "Read Markdown",
    eyebrow: "",
    path: "",
    body,
    headings: [],
    scroll: { y: 0 },
  };
}

async function loadPage(
  site: Site,
  { restore = false, scrollY = null }: RouteOptions,
): Promise<Page> {
  const raw = pathOf(new URL(location.href)).replace(/^\/+/, "");
  const hit = resolve(site, raw);

  if (!hit) {
    const body = (
      <Message
        site={site}
        text={`There's no Markdown file at “${raw}” in this folder.`}
      />
    );
    return {
      current: {},
      crumbs: raw,
      title: "Not found",
      eyebrow: "",
      path: raw,
      body,
      headings: [],
      scroll: { y: 0 },
    };
  }

  // Use the file's own path as the address, so relative links resolve from it.
  const canonical = pageUrl("file" in hit ? hit.file : hit.dir);
  if (canonical !== location.pathname + location.search)
    history.replaceState(history.state, "", canonical + location.hash);

  if ("dir" in hit) {
    const { dir } = hit;
    const body = <FolderList site={site} dir={dir} />;
    return {
      current: { dir },
      crumbs: dir,
      title: dir ? basename(dir) : site.name,
      eyebrow: "Folder",
      path: dir || "./",
      body,
      headings: [],
      scroll: { y: 0 },
    };
  }

  const { file } = hit;
  let md;
  try {
    md = await readFile(site, file);
  } catch (err) {
    const hint = STATIC
      ? "Was it moved or deleted? Open it again."
      : "Is the server still running?";
    const body = (
      <Message
        site={site}
        text={`Couldn't load this file (${(err as Error).message}). ${hint}`}
      />
    );
    return {
      current: { file, words: 0 },
      crumbs: file,
      title: stem(file),
      eyebrow: "",
      path: file,
      body,
      headings: [],
    };
  }

  const doc = renderMarkdown(site, md, file);
  const saved = positions[file];
  return {
    current: { file, words: doc.words },
    crumbs: file,
    title: doc.title,
    titleId: doc.titleId,
    eyebrow: `${minutes(doc.words)} min read · ${doc.words.toLocaleString("en-GB")} words`,
    path: file,
    doc: doc.root,
    headings: doc.headings,
    scroll:
      scrollY !== null
        ? { y: scrollY }
        : location.hash
          ? { hash: location.hash }
          : restore && saved < 0.995
            ? { ratio: saved }
            : { y: 0 },
  };
}

/* ---------- Progress and position ---------- */

function minutes(words: number) {
  return Math.max(1, Math.round(words / WPM));
}

function scrollRatio() {
  const max = document.documentElement.scrollHeight - innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 1;
}

function scrollToRatio(ratio: number) {
  const max = document.documentElement.scrollHeight - innerHeight;
  window.scrollTo({ top: ratio * max, behavior: "instant" });
}

function savePosition(current: Current) {
  if (!current?.file) return;
  positions[current.file] = scrollRatio();
  store.set("quire.positions", positions);
}

/* ---------- App ---------- */

const wideQuery = matchMedia("(min-width: 64rem)");
const BLANK: Page = {
  current: null,
  crumbs: null,
  title: "",
  eyebrow: "",
  path: "",
  headings: [],
};

function App() {
  const [settings, setSettings] = useState<Settings>(() => ({
    theme: "auto",
    font: "serif",
    size: 19,
    measure: 66,
    leading: 1.7,
    ...store.get("quire.settings", {}),
  }));
  const [site, setSite] = useState<Site | null>(null);
  const [page, setPage] = useState<Page>(BLANK);
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [wide, setWide] = useState(wideQuery.matches);
  const [progress, setProgress] = useState<{
    ratio: number;
    active: string | null;
  }>({ ratio: 0, active: null });
  // Event listeners are added once, so they read state through this.
  const latest = useRef({ site, page });
  latest.current = { site, page };
  const keepRatio = useRef<number | null>(null);
  const saveTimer = useRef(0);
  const filter = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLInputElement>(null);
  const side = useRef<HTMLElement>(null);
  const docBody = useRef<HTMLDivElement>(null);

  async function go(site: Site | null, opts: RouteOptions = {}) {
    const token = ++loadToken;
    setDrawer(false);
    if (!site) return setPage(welcome());
    const next = await loadPage(site, opts);
    if (token === loadToken) setPage(next);
  }

  function navigate(url: string) {
    savePosition(latest.current.page.current);
    history.replaceState({ scrollY: window.scrollY }, "");
    history.pushState(null, "", url);
    go(latest.current.site);
  }

  function update() {
    const ratio = scrollRatio();
    let active: string | null = null;
    for (const h of latest.current.page.headings) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top < innerHeight * 0.3)
        active = h.id;
      else break;
    }
    setProgress((p) =>
      p.ratio === ratio && p.active === active ? p : { ratio, active },
    );
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(
      () => savePosition(latest.current.page.current),
      400,
    );
  }

  function scrollToHash(hash: string) {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {}
    const el =
      document.getElementById(id) ||
      document.querySelector(`#doc-title[data-slug="${CSS.escape(id)}"]`);
    requestAnimationFrame(() => {
      if (el) el.scrollIntoView({ block: "start" });
      else window.scrollTo({ top: 0, behavior: "instant" });
      update();
    });
  }

  // Keeps the reading position while the text reflows.
  function changeSetting(
    change: Partial<Settings> | ((s: Settings) => Partial<Settings>),
  ) {
    keepRatio.current = scrollRatio();
    setSettings((s) => ({
      ...s,
      ...(typeof change === "function" ? change(s) : change),
    }));
  }

  function openLocal({ name, files }: Local) {
    const markdown = [...files.keys()].filter(isMarkdown).sort();
    if (!markdown.length)
      return setPage(
        welcome(
          "There are no Markdown files in what you opened. Quire reads .md, .markdown and .mdown files.",
        ),
      );
    savePosition(latest.current.page.current);
    latest.current.site?.blobs.forEach((url) => URL.revokeObjectURL(url));
    const next = makeSite(name, markdown, files);
    setSite(next);
    history.pushState(null, "", pageUrl(""));
    go(next, { restore: true });
  }

  useLayoutEffect(() => {
    // On <html>, so the page's own scrollbar and background follow the theme too.
    const root = document.documentElement;
    if (settings.theme === "auto") delete root.dataset.reader;
    else root.dataset.reader = settings.theme;
    root.style.setProperty(
      "--reader-font",
      FONTS[settings.font] || FONTS.serif,
    );
    root.style.setProperty("--reader-size", settings.size + "px");
    root.style.setProperty("--reader-measure", settings.measure + "ch");
    root.style.setProperty("--reader-leading", String(settings.leading));
    store.set("quire.settings", settings);
    if (keepRatio.current !== null) scrollToRatio(keepRatio.current);
    keepRatio.current = null;
  }, [settings]);

  // Moves the sanitized nodes in
  useLayoutEffect(() => {
    if (page.doc) docBody.current!.replaceChildren(page.doc);
  }, [page]);

  useEffect(() => {
    document.title = site?.name ? `${page.title} · ${site.name}` : page.title;
    const s = page.scroll;
    if (!s) return;
    if ("hash" in s) return scrollToHash(s.hash);
    requestAnimationFrame(() => {
      if ("ratio" in s) scrollToRatio(s.ratio);
      else window.scrollTo({ top: s.y, behavior: "instant" });
      update();
    });
  }, [page]);

  // Below lg the sidebar slides over the page as a modal drawer: the page
  // behind it goes inert, and focus moves into it and back to its toggle.
  const modal = drawer && !wide;
  useEffect(() => {
    // Set here because Preact's types don't allow role="dialog" on <aside>.
    if (modal) {
      side.current!.setAttribute("role", "dialog");
      side.current!.setAttribute("aria-modal", "true");
      filter.current!.focus();
    } else {
      side.current!.removeAttribute("role");
      side.current!.removeAttribute("aria-modal");
      if (side.current!.contains(document.activeElement))
        toggle.current!.focus();
    }
  }, [modal]);

  useEffect(() => {
    document.addEventListener("click", (e) => {
      const a = (e.target as Element).closest<HTMLAnchorElement>(
        "a[data-internal], a[data-anchor]",
      );
      if (
        !a ||
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      e.preventDefault();
      if (a.dataset.anchor) {
        history.replaceState(history.state, "", a.getAttribute("href"));
        scrollToHash(a.getAttribute("href")!);
        return;
      }
      const url = new URL(a.href);
      if (
        url.pathname + url.search === location.pathname + location.search &&
        url.hash
      ) {
        history.replaceState(history.state, "", url.hash);
        scrollToHash(url.hash);
      } else {
        navigate(url.pathname + url.search + url.hash);
      }
    });

    window.addEventListener("popstate", (e) => {
      go(latest.current.site, { scrollY: e.state?.scrollY ?? null });
    });

    let ticking = false;
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          update();
        });
      },
      { passive: true },
    );
    window.addEventListener("resize", update);
    // Another tab changed the settings.
    window.addEventListener("storage", (e) => {
      if (e.key === "quire.settings")
        setSettings((s) => ({ ...s, ...store.get("quire.settings", {}) }));
    });
    window.addEventListener("pagehide", () =>
      savePosition(latest.current.page.current),
    );
    wideQuery.addEventListener("change", () => {
      setWide(wideQuery.matches);
      setDrawer(false);
    });

    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        (e.target as Element).closest(
          "input:not([type=radio]):not([type=range]), textarea, [contenteditable]",
        )
      )
        return;
      if (e.key === "/") {
        e.preventDefault();
        setDrawer(true);
        filter.current!.focus();
      } else if (e.key === "[") setDrawer((d) => !d);
      else if (e.key === "+" || e.key === "=")
        changeSetting((s) => ({ size: Math.min(25, s.size + 1) }));
      else if (e.key === "-" || e.key === "_")
        changeSetting((s) => ({ size: Math.max(15, s.size - 1) }));
      else if (e.key === "t")
        changeSetting((s) => ({
          theme: THEMES[(THEMES.indexOf(s.theme) + 1) % THEMES.length],
        }));
      else if (e.key === "Escape") setDrawer(false);
    });

    if (STATIC) {
      addEventListener("dragover", (e) => {
        if (!e.dataTransfer!.types.includes("Files")) return;
        e.preventDefault();
        document.body.classList.add("dropping");
      });
      addEventListener("dragleave", (e) => {
        if (!e.relatedTarget) document.body.classList.remove("dropping");
      });
      addEventListener("drop", async (e) => {
        e.preventDefault();
        document.body.classList.remove("dropping");
        openLocal(await fromDropped(e.dataTransfer!));
      });
      setPage(welcome());
      return;
    }

    fetch("/api/tree", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(
        (data: { name: string; files?: string[] }) => {
          const next = makeSite(data.name, data.files || []);
          setSite(next);
          go(next, { restore: true });
        },
        (err: Error) => {
          setPage({
            ...BLANK,
            title: "Couldn't list files",
            body: `The server didn't answer (${err.message}). Start it with "go run ." and reload.`,
          });
        },
      );
  }, []);

  function onFilterKey(e: KeyboardEvent) {
    // Enter and Escape also confirm or cancel IME composition; keyCode 229 catches Safari, which clears isComposing first.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      const first = side.current!.querySelector("#tree a[data-path]");
      if (first) {
        setQuery("");
        navigate(first.getAttribute("href")!);
      }
    } else if (e.key === "Escape") {
      setQuery("");
      filter.current!.blur();
    }
  }

  const { current } = page;
  const words = current?.words;
  const timeLeft = !words
    ? ""
    : progress.ratio >= 0.995
      ? "Finished"
      : `${Math.max(1, Math.ceil(minutes(words) * (1 - progress.ratio)))} min left`;
  const showToc = page.headings.length >= 2;
  const toc = <Toc headings={page.headings} active={progress.active} />;

  const radios = <K extends "theme" | "font">(
    key: K,
    options: [Settings[K], string][],
  ) => (
    <div class="join w-full">
      {options.map(([value, label]) => (
        <input
          class="seg join-item btn btn-sm flex-1"
          type="radio"
          name={key}
          value={value}
          aria-label={label}
          checked={settings[key] === value}
          onChange={() => changeSetting({ [key]: value })}
        />
      ))}
    </div>
  );
  const range = (
    key: "size" | "measure" | "leading",
    label: string,
    out: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label class="flex flex-col gap-1.5" for={key}>
      <span class="flex justify-between">
        <span class="eyebrow text-base-content/60">{label}</span>
        <span class="tabular text-xs text-base-content/70">{out}</span>
      </span>
      <input
        id={key}
        type="range"
        min={min}
        max={max}
        step={step}
        class="range range-xs w-full"
        value={settings[key]}
        onInput={(e) => changeSetting({ [key]: Number(e.currentTarget.value) })}
      />
    </label>
  );

  return (
    <div class="drawer lg:drawer-open">
      <input
        id="sidebar-toggle"
        ref={toggle}
        type="checkbox"
        class="drawer-toggle"
        checked={drawer}
        onChange={(e) => setDrawer(e.currentTarget.checked)}
      />
      <div class="drawer-content flex min-h-screen flex-col" inert={modal}>
        <header class="topbar sticky z-5 border-b border-base-300">
          <div class="gutter navbar min-h-14 gap-2">
            <div class="flex min-w-0 flex-1 items-center gap-1">
              <label
                for="sidebar-toggle"
                class="btn btn-ghost btn-square btn-sm drawer-button lg:hidden"
                aria-label="Show files"
                title="Files ( [ )"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 6h16M4 12h10M4 18h13" />
                </svg>
              </label>
              <nav
                id="crumbs"
                class="breadcrumbs min-w-0 py-0 text-sm"
                aria-label="Breadcrumb"
              >
                <ul>
                  {site && page.crumbs !== null && (
                    <Crumbs site={site} path={page.crumbs} />
                  )}
                </ul>
              </nav>
            </div>
            <div class="flex shrink-0 items-baseline gap-1">
              <span
                id="time-left"
                class="tabular hidden text-xs text-base-content/60 sm:inline"
              >
                {timeLeft}
              </span>
              <button
                type="button"
                popovertarget="settings"
                class="btn btn-ghost btn-square btn-sm font-serif text-base"
                aria-label="Reading settings"
                title="Reading settings"
              >
                Aa
              </button>
              {/* The Aa button sits at the top right of the sticky bar, so the menu is pinned there. */}
              <div
                id="settings"
                popover="auto"
                class="settings w-[min(19rem,calc(100vw-32px))] rounded-box border border-base-300 bg-base-100 p-4 text-base-content shadow-xl"
              >
                <div class="flex flex-col gap-4">
                  <div class="flex flex-col gap-1.5">
                    <span class="eyebrow text-base-content/60">Theme</span>
                    {radios("theme", [
                      ["auto", "Auto"],
                      ["paper", "Paper"],
                      ["sepia", "Sepia"],
                      ["ink", "Ink"],
                    ])}
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <span class="eyebrow text-base-content/60">Typeface</span>
                    {radios("font", [
                      ["serif", "Serif"],
                      ["sans", "Sans"],
                      ["mono", "Mono"],
                    ])}
                  </div>
                  {range("size", "Text size", settings.size + " px", 15, 25, 1)}
                  {range(
                    "measure",
                    "Line length",
                    "~" + settings.measure + " characters",
                    46,
                    84,
                    2,
                  )}
                  {range(
                    "leading",
                    "Line spacing",
                    settings.leading.toFixed(2),
                    1.4,
                    2.1,
                    0.05,
                  )}
                  <div class="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-base-300 pt-3 text-xs text-base-content/70">
                    <span>
                      <kbd class="kbd kbd-xs">/</kbd> find file
                    </span>
                    <span>
                      <kbd class="kbd kbd-xs">[</kbd> files
                    </span>
                    <span>
                      <kbd class="kbd kbd-xs">+</kbd>{" "}
                      <kbd class="kbd kbd-xs">−</kbd> size
                    </span>
                    <span>
                      <kbd class="kbd kbd-xs">t</kbd> theme
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <progress
            id="read-bar"
            class="read-bar progress progress-primary"
            value={Math.round(progress.ratio * 1000)}
            max={1000}
          />
        </header>

        <main class="gutter flex flex-1 justify-center gap-12 pb-24 pt-10 sm:pt-14">
          <article class="page w-full min-w-0" id="article" lang="en-GB">
            <header class="mb-10 flex flex-col gap-3">
              <p id="doc-eyebrow" class="eyebrow text-base-content/60">
                {page.eyebrow}
              </p>
              <h1
                id="doc-title"
                class="doc-title"
                data-slug={page.titleId ?? undefined}
              >
                {page.title}
              </h1>
              <p
                id="doc-path"
                class="break-all font-mono text-xs text-base-content/60"
              >
                {page.path}
              </p>
            </header>
            <details
              id="toc-inline"
              class="collapse collapse-arrow mb-10 border border-base-300 bg-base-200 text-sm xl:hidden"
              hidden={!showToc}
            >
              <summary class="collapse-title min-h-0 py-3 font-semibold">
                On this page
              </summary>
              <nav class="collapse-content toc" aria-label="On this page">
                {toc}
              </nav>
            </details>
            {page.doc ? (
              <div key="doc" ref={docBody} id="doc-body" class="prose-q" />
            ) : (
              <div key="body" id="doc-body" class="prose-q">
                {page.body}
              </div>
            )}
            <footer
              id="doc-footer"
              class="mt-16 grid gap-3 border-t border-base-300 pt-6 text-sm sm:grid-cols-2"
            >
              {site && current?.file && (
                <Footer site={site} file={current.file} />
              )}
            </footer>
          </article>
          <aside
            id="toc-side"
            class="hidden w-56 shrink-0 xl:block"
            hidden={!showToc}
          >
            <nav
              class="side-toc toc sticky top-24 max-h-[calc(100dvh-8rem)] overflow-y-auto text-sm"
              aria-label="On this page"
            >
              <p class="eyebrow mb-2 font-semibold text-base-content/70">
                On this page
              </p>
              <div id="toc-side-list">{toc}</div>
            </nav>
          </aside>
        </main>
      </div>

      <div class="drawer-side z-20">
        <label
          for="sidebar-toggle"
          aria-label="Close files"
          class="drawer-overlay"
        />
        <aside
          id="sidebar"
          ref={side}
          aria-label="Files"
          class="flex min-h-full w-72 flex-col gap-3 border-e border-base-300 bg-base-200 px-2"
          style={{
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.9rem)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.9rem)",
            paddingLeft: "max(8px, env(safe-area-inset-left, 0px))",
          }}
        >
          <a
            href={STATIC ? pageUrl("") : "/"}
            id="home"
            data-internal="1"
            class="flex items-baseline gap-2 px-3"
          >
            <span class="wordmark">Quire</span>
            <span
              id="root-name"
              class="truncate font-mono text-xs text-base-content/60"
            >
              {site && site.name + "/"}
            </span>
          </a>
          {STATIC && (
            <div id="open-local" class="mx-1 grid grid-cols-2 gap-2">
              <label
                for="open-file"
                class="btn btn-sm border-base-300 bg-base-100"
              >
                Open file
              </label>
              <label
                for="open-folder"
                class="btn btn-sm border-base-300 bg-base-100"
              >
                Open folder
              </label>
            </div>
          )}
          <label class="input input-sm mx-1 w-auto" for="filter">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              class="opacity-50"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="filter"
              ref={filter}
              type="search"
              placeholder="Search files"
              autocomplete="off"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onFilterKey}
            />
            <kbd class="kbd kbd-xs">/</kbd>
          </label>
          {site ? (
            <Tree
              site={site}
              query={query}
              file={current?.file}
              open={current?.file || current?.dir || ""}
            />
          ) : (
            <ul id="tree" class="tree menu menu-sm w-full p-0" />
          )}
          <p class="mt-auto flex items-baseline justify-between gap-2 px-3 text-xs text-base-content/60">
            <span id="tree-count">
              {site &&
                `${site.files.length} Markdown ${site.files.length === 1 ? "file" : "files"}`}
            </span>
            <span class="flex gap-3">
              <a
                href="https://github.com/jianyuan/quire"
                class="link link-hover"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
              {/* GitHub Pages would offer a .md file as a download, so the static build links to a plain-text copy. */}
              <a
                href={STATIC ? "licenses.txt" : "/licenses"}
                id="licenses"
                class="link link-hover"
              >
                Licenses
              </a>
            </span>
          </p>
        </aside>
      </div>

      {STATIC &&
        ["open-file", "open-folder"].map((id) => (
          <input
            id={id}
            type="file"
            hidden
            {...(id === "open-file"
              ? { accept: ".md,.markdown,.mdown,text/markdown", multiple: true }
              : { webkitdirectory: true })}
            onChange={(e) => {
              const input = e.currentTarget;
              if (input.files?.length) openLocal(fromPicked(input.files));
              input.value = "";
            }}
          />
        ))}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
