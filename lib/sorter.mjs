import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, basename, extname } from "node:path";
export const VERSION = "1.0.0";
export const DEFAULT_RULES = [
  { folder: "Receipts", contains: ["receipt", "invoice"], extensions: [] },
  {
    folder: "Images",
    contains: [],
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "heic", "svg"],
  },
  {
    folder: "Documents",
    contains: [],
    extensions: ["pdf", "doc", "docx", "txt", "rtf", "md", "pages"],
  },
  {
    folder: "Spreadsheets",
    contains: [],
    extensions: ["csv", "xlsx", "xls", "numbers"],
  },
  { folder: "Presentations", contains: [], extensions: ["ppt", "pptx", "key"] },
  {
    folder: "Archives",
    contains: [],
    extensions: ["zip", "7z", "rar", "tar", "gz"],
  },
  { folder: "Video", contains: [], extensions: ["mp4", "mov", "mkv", "webm"] },
  { folder: "Audio", contains: [], extensions: ["mp3", "wav", "m4a", "flac"] },
];
const STATE = ".downloads-sorter",
  PARTIAL = /\.(crdownload|download|part|partial|tmp|opdownload)$/i;
const sig = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  mtime: String(s.mtimeNs),
});
const same = (a, b) =>
  a && b && ["dev", "ino", "size", "mtime"].every((k) => a[k] === b[k]);
export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 20)
    throw Error("Use between 1 and 20 sorting rules.");
  return rules.map((r) => {
    if (
      !r ||
      typeof r.folder !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(r.folder) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(r.folder)
    )
      throw Error(
        "Folder names must use 1–40 letters, digits, spaces, hyphens or underscores.",
      );
    const words = (x, pattern) => {
      if (
        !Array.isArray(x) ||
        x.length > 40 ||
        x.some((v) => typeof v !== "string" || !pattern.test(v))
      )
        throw Error("Invalid filename or extension rule.");
      return [...new Set(x.map((v) => v.toLowerCase()))];
    };
    const contains = words(r.contains || [], /^[^\x00-\x1f/\\]{1,50}$/),
      extensions = words(r.extensions || [], /^[a-zA-Z0-9]{1,12}$/);
    if (!contains.length && !extensions.length)
      throw Error("Each rule needs a filename word or extension.");
    return { folder: r.folder, contains, extensions };
  });
}
export function classify(name, rules = DEFAULT_RULES) {
  const extension = extname(name).slice(1).toLowerCase(),
    lower = name.toLowerCase();
  return (
    rules.find(
      (r) =>
        r.contains.some((w) => lower.includes(w)) ||
        r.extensions.includes(extension),
    )?.folder || null
  );
}
export async function resolveRoot(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 4096)
    throw Error("Choose a folder first.");
  const requested = resolve(input);
  const s = await fs.lstat(requested);
  if (s.isSymbolicLink() || !s.isDirectory())
    throw Error("Choose a real folder, not a shortcut or symbolic link.");
  return fs.realpath(requested);
}
async function statFile(path) {
  const s = await fs.lstat(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink())
    throw Error("Only regular files are supported.");
  return sig(s);
}
export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function directory(path, create = false) {
  try {
    const s = await fs.lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw Error("Destination is not a real folder: " + basename(path));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (!create) return false;
    await fs.mkdir(path, { mode: 0o700 });
  }
  return true;
}
export async function scanFolder(
  input,
  {
    rules = DEFAULT_RULES,
    minimumAgeMs = 15000,
    now = Date.now(),
    ignore = new Map(),
    maxBytes = 2 * 1024 ** 3,
  } = {},
) {
  const root = await resolveRoot(input);
  rules = validateRules(rules);
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0)
    throw Error("Invalid settling interval.");
  const names = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (names.length > 10000)
    throw Error("Choose a folder with fewer than 10,000 entries.");
  const moves = [],
    skipped = [],
    reserved = new Map();
  for (const entry of names) {
    const name = entry.name,
      from = join(root, name);
    if (name.startsWith(".")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      skipped.push({ name, reason: "Folder or shortcut" });
      continue;
    }
    if (PARTIAL.test(name)) {
      skipped.push({ name, reason: "Download in progress" });
      continue;
    }
    try {
      const before = await statFile(from);
      if (same(ignore.get(name), before)) continue;
      const age = now - Number(before.mtime) / 1e6;
      if (minimumAgeMs > 0 && age < minimumAgeMs) {
        skipped.push({ name, reason: "Recently changed" });
        continue;
      }
      if (Number(before.size) > maxBytes) {
        skipped.push({ name, reason: "Larger than 2 GiB" });
        continue;
      }
      const folder = classify(name, rules);
      if (!folder) {
        skipped.push({ name, reason: "No matching rule" });
        continue;
      }
      const exists = await directory(join(root, folder));
      if (!reserved.has(folder))
        reserved.set(
          folder,
          new Set(
            exists
              ? (await fs.readdir(join(root, folder))).map((n) =>
                  n.toLowerCase(),
                )
              : [],
          ),
        );
      const used = reserved.get(folder),
        extension = extname(name),
        stem = name.slice(0, name.length - extension.length);
      let target = name,
        index = 2;
      while (used.has(target.toLowerCase())) {
        if (index > 10000) throw Error("Too many duplicate filenames.");
        target = `${stem} (${index++})${extension}`;
      }
      used.add(target.toLowerCase());
      const sha256 = await hashFile(from),
        after = await statFile(from);
      if (!same(before, after)) {
        skipped.push({ name, reason: "Changed during preview" });
        continue;
      }
      moves.push({
        name,
        target: folder + "/" + target,
        signature: before,
        sha256,
        size: Number(before.size),
      });
    } catch (e) {
      skipped.push({ name, reason: e.message });
    }
  }
  return {
    schema: "downloads-sorter-plan/1",
    id: randomUUID(),
    root,
    created_at: new Date().toISOString(),
    rules,
    moves,
    skipped,
  };
}
async function atomicJSON(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, path);
  } catch (e) {
    await fs.unlink(temp).catch(() => {});
    throw e;
  }
}
async function stateDir(root) {
  await directory(join(root, STATE), true);
  return join(root, STATE);
}
async function withLock(root, fn) {
  const dir = await stateDir(root),
    path = join(dir, "active.lock");
  let handle;
  try {
    handle = await fs.open(path, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error(
        "Another run holds this folder’s lock. Close the other sorter; see README if a crash left the lock behind.",
      );
    throw e;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }),
    );
    return await fn(dir);
  } finally {
    await handle.close();
    await fs.unlink(path);
  }
}
function entryPaths(root, e) {
  if (
    !e ||
    typeof e.name !== "string" ||
    e.name.startsWith(".") ||
    basename(e.name) !== e.name ||
    /[\\/\x00]/.test(e.name) ||
    typeof e.target !== "string" ||
    !e.target.includes("/")
  )
    throw Error("Invalid move record.");
  const parts = e.target.split("/");
  if (
    parts.length !== 2 ||
    !parts[1] ||
    parts[1].startsWith(".") ||
    basename(parts[1]) !== parts[1] ||
    /[\\\x00]/.test(parts[1]) ||
    !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(parts[0])
  )
    throw Error("Invalid move destination.");
  if (!/^[a-f0-9]{64}$/.test(e.sha256))
    throw Error("Invalid file fingerprint.");
  return {
    from: join(root, e.name),
    to: join(root, ...parts),
    folder: join(root, parts[0]),
  };
}
async function removeSame(path, expected) {
  try {
    const s = await statFile(path);
    if (s.dev === expected.dev && s.ino === expected.ino) await fs.unlink(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
export async function applyPlan(plan) {
  if (
    plan?.schema !== "downloads-sorter-plan/1" ||
    !Array.isArray(plan.moves) ||
    plan.moves.length > 10000
  )
    throw Error("Invalid preview plan.");
  const root = await resolveRoot(plan.root);
  return withLock(root, async (dir) => {
    const id = randomUUID(),
      file = join(dir, id + ".json"),
      journal = {
        schema: "downloads-sorter-run/1",
        id,
        root,
        created_at: new Date().toISOString(),
        state: "running",
        moves: [],
      };
    await atomicJSON(file, journal);
    for (const entry of plan.moves) {
      const e = { ...entry, phase: "planned" };
      try {
        const p = entryPaths(root, e);
        await directory(p.folder, true);
        if (
          !same(await statFile(p.from), e.signature) ||
          (await hashFile(p.from)) !== e.sha256 ||
          !same(await statFile(p.from), e.signature)
        )
          throw Error("Source changed after preview; left in place.");
        journal.moves.push(e);
        await atomicJSON(file, journal);
        await fs.link(p.from, p.to);
        try {
          if (!same(await statFile(p.from), e.signature))
            throw Error("Source changed while sorting; original retained.");
          await fs.unlink(p.from);
          e.phase = "moved";
        } catch (error) {
          await removeSame(p.to, e.signature);
          throw error;
        }
      } catch (error) {
        e.phase = "skipped";
        e.error =
          error.code === "EEXIST"
            ? "Destination already exists; nothing overwritten."
            : error.message;
        if (!journal.moves.includes(e)) journal.moves.push(e);
      }
      await atomicJSON(file, journal);
    }
    journal.state = "complete";
    journal.completed_at = new Date().toISOString();
    await atomicJSON(file, journal);
    return journal;
  });
}
function validID(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw Error("Invalid run ID.");
  return id;
}
export async function listRuns(input) {
  const root = await resolveRoot(input),
    dir = join(root, STATE);
  if (!(await directory(dir))) return [];
  const names = (await fs.readdir(dir)).filter((n) =>
    /^[a-f0-9-]{36}\.json$/.test(n),
  );
  const runs = [];
  for (const name of names.slice(-200)) {
    const path = join(dir, name);
    try {
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink() || stat.size > 10 * 1024 ** 2) continue;
      const r = JSON.parse(await fs.readFile(path, "utf8"));
      if (r.schema === "downloads-sorter-run/1" && Array.isArray(r.moves))
        runs.push(r);
    } catch {}
  }
  return runs.sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}
export async function undoRun(input, id) {
  const root = await resolveRoot(input);
  validID(id);
  return withLock(root, async (dir) => {
    const path = join(dir, id + ".json"),
      stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 10 * 1024 ** 2)
      throw Error("Invalid run history.");
    const journal = JSON.parse(await fs.readFile(path, "utf8"));
    if (
      journal.schema !== "downloads-sorter-run/1" ||
      journal.id !== id ||
      journal.root !== root ||
      !Array.isArray(journal.moves)
    )
      throw Error("History does not belong to this folder.");
    for (const e of [...journal.moves].reverse()) {
      if (!["moved", "planned"].includes(e.phase)) continue;
      try {
        const p = entryPaths(root, e);
        await directory(p.folder);
        let current;
        try {
          current = await statFile(p.to);
        } catch (error) {
          if (
            error.code === "ENOENT" &&
            e.phase === "planned" &&
            same(await statFile(p.from), e.signature) &&
            (await hashFile(p.from)) === e.sha256
          ) {
            e.phase = "not-moved";
            continue;
          }
          throw error;
        }
        if (!same(current, e.signature) || (await hashFile(p.to)) !== e.sha256)
          throw Error("Sorted file changed; kept in its current location.");
        try {
          const source = await statFile(p.from);
          if (source.dev === current.dev && source.ino === current.ino) {
            await fs.unlink(p.to);
            e.phase = "undone";
          } else
            throw Error(
              "Original filename is now occupied; nothing overwritten.",
            );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await fs.link(p.to, p.from);
          await removeSame(p.to, current);
          e.phase = "undone";
        }
        delete e.undo_error;
      } catch (error) {
        e.undo_error = error.message;
      }
      await atomicJSON(path, journal);
    }
    journal.state = journal.moves.some((e) =>
      ["moved", "planned"].includes(e.phase),
    )
      ? "partially-undone"
      : "undone";
    await atomicJSON(path, journal);
    return journal;
  });
}
export async function snapshot(input) {
  const root = await resolveRoot(input),
    seen = new Map();
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (item.isFile() && !item.isSymbolicLink())
      try {
        seen.set(item.name, await statFile(join(root, item.name)));
      } catch {}
  }
  return seen;
}
