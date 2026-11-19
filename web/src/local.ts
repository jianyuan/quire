// Reads files from the visitor's own disk for the static build, which has
// no server to list or serve them. Nothing leaves the browser.

export type Local = { name: string; files: Map<string, File> };

// Like the Go server, skip hidden files and folders (.git, .obsidian) and
// dependency folders.
const SKIP_DIRS = new Set(["node_modules", "vendor"]);
const skip = (path: string) =>
  path
    .split("/")
    .some(
      (part, i, parts) =>
        part.startsWith(".") || (i < parts.length - 1 && SKIP_DIRS.has(part)),
    );

// Takes [path, File] pairs and returns { name, files }, where files maps
// each path to its File. When everything is in one folder, that folder is
// the root and paths are relative to it, as they are with the server.
// Loose files go at the root of a folder called "Files".
function collect(pairs: [string, File][]): Local {
  const tops = new Set(
    pairs.map(([p]) => (p.includes("/") ? p.split("/")[0] : "")),
  );
  const name = tops.size === 1 && !tops.has("") ? [...tops][0] : null;
  const files = new Map<string, File>();
  for (const [p, file] of pairs) {
    const rel = name ? p.slice(name.length + 1) : p;
    if (!skip(rel)) files.set(rel, file);
  }
  return { name: name || "Files", files };
}

// Files from an <input type="file">, with or without webkitdirectory.
export function fromPicked(fileList: FileList): Local {
  return collect([...fileList].map((f) => [f.webkitRelativePath || f.name, f]));
}

// Files and folders dropped on the page. Call it from inside the drop
// handler: the browser empties the DataTransfer once the handler returns.
export async function fromDropped(dataTransfer: DataTransfer): Promise<Local> {
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e) => e != null);
  if (!entries.length) return fromPicked(dataTransfer.files);
  const pairs: [string, File][] = [];
  await Promise.all(entries.map((e) => walk(e, pairs, true)));
  return collect(pairs);
}

async function walk(
  entry: FileSystemEntry,
  out: [string, File][],
  top: boolean,
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) =>
      (entry as FileSystemFileEntry).file(ok, fail),
    ).catch(() => null);
    if (file) out.push([entry.fullPath.replace(/^\/+/, ""), file]);
    return;
  }
  if (!top && (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name))) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries hands back a folder's entries in batches, then an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) =>
      reader.readEntries(ok, fail),
    ).catch(() => []);
    if (!batch.length) return;
    await Promise.all(batch.map((e) => walk(e, out, false)));
  }
}
