#!/usr/bin/env node
import http from "node:http";
import * as fs from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import {
  scanFolder,
  applyPlan,
  undoRun,
  listRuns,
  snapshot,
  validateRules,
  resolveRoot,
  DEFAULT_RULES,
} from "./lib/sorter.mjs";
const exec = promisify(execFile),
  here = fileURLToPath(new URL(".", import.meta.url));
export async function createApp({
  dataDir = join(here, ".local-data"),
  intervalMs = 15000,
  settleMs = 15000,
} = {}) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  let config = { root: null, rules: DEFAULT_RULES },
    preview = null,
    busy = false,
    automatic = false,
    seen = new Map(),
    lastError = null;
  const token = randomBytes(32).toString("hex");
  try {
    const saved = JSON.parse(
      await fs.readFile(join(dataDir, "settings.json"), "utf8"),
    );
    config = {
      root: typeof saved.root === "string" ? saved.root : null,
      rules: validateRules(saved.rules),
    };
  } catch {}
  const persist = () =>
    fs.writeFile(
      join(dataDir, "settings.json"),
      JSON.stringify(config, null, 2),
      { mode: 0o600 },
    );
  const exclusive = async (fn) => {
    if (busy)
      throw Error("A file operation is still running. Try again shortly.");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
  async function tick() {
    if (!automatic || !config.root || busy) return;
    try {
      await exclusive(async () => {
        const current = await snapshot(config.root);
        for (const name of seen.keys())
          if (!current.has(name)) seen.delete(name);
        const ignored = new Map(
          [...current].filter(([name]) => seen.has(name)),
        );
        const plan = await scanFolder(config.root, {
          rules: config.rules,
          minimumAgeMs: settleMs,
          ignore: ignored,
        });
        if (!automatic) return;
        if (plan.moves.length) {
          const run = await applyPlan(plan);
          for (const e of run.moves)
            if (e.phase === "moved") seen.set(e.name, e.signature);
        }
        lastError = null;
      });
    } catch (e) {
      lastError = e.message;
      automatic = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  let server;
  const state = async () => ({
    root: config.root,
    rules: config.rules,
    defaultRules: DEFAULT_RULES,
    automatic,
    busy,
    lastError,
    intervalSeconds: intervalMs / 1000,
    settleSeconds: settleMs / 1000,
    suggestedFolder: join(homedir(), "Downloads"),
    runs: config.root ? await listRuns(config.root).catch(() => []) : [],
  });
  async function jsonBody(req) {
    let chunks = [],
      bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 256000) throw Error("Request is too large.");
      chunks.push(chunk);
    }
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
  }
  const reply = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };
  server = http.createServer(async (req, res) => {
    const port = server.address()?.port,
      allowed = ["127.0.0.1:" + port, "localhost:" + port],
      host = req.headers.host,
      origin = req.headers.origin;
    try {
      if (
        !allowed.includes(host) ||
        (origin && !allowed.map((h) => "http://" + h).includes(origin)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return reply(res, 403, {
          error: "Only the local app can access this server.",
        });
      const url = new URL(req.url, "http://" + host);
      if (url.pathname.startsWith("/api/")) {
        const supplied = req.headers["x-local-token"];
        if (
          typeof supplied !== "string" ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return reply(res, 403, {
            error: "Reopen the local app page to continue.",
          });
        if (req.method === "GET" && url.pathname === "/api/state")
          return reply(res, 200, await state());
        if (req.method !== "POST")
          return reply(res, 405, { error: "Method not allowed." });
        const body = await jsonBody(req);
        let result;
        switch (url.pathname) {
          case "/api/folder":
            result = await exclusive(async () => {
              automatic = false;
              config.root = await resolveRoot(body.path);
              preview = null;
              seen = new Map();
              await persist();
              return await state();
            });
            break;
          case "/api/pick": {
            if (process.platform === "darwin") {
              const r = await exec(
                "/usr/bin/osascript",
                [
                  "-e",
                  'POSIX path of (choose folder with prompt "Choose the folder Downloads Sorter may organize")',
                ],
                { timeout: 120000, maxBuffer: 8192 },
              );
              result = { path: r.stdout.trim() };
            } else if (process.platform === "win32") {
              const script =
                'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq "OK"){Write-Output $d.SelectedPath}';
              const r = await exec(
                "powershell.exe",
                ["-NoProfile", "-STA", "-Command", script],
                { timeout: 120000, maxBuffer: 8192 },
              );
              result = { path: r.stdout.trim() };
            } else
              result = { path: null, message: "Paste a folder path below." };
            break;
          }
          case "/api/demo":
            result = await exclusive(async () => {
              automatic = false;
              const root = join(dataDir, "demo-" + randomUUID());
              await fs.mkdir(root);
              for (const [name, text] of [
                ["course-notes.pdf", "Demo document"],
                ["receipt-coffee.txt", "Demo receipt"],
                ["Screenshot.png", "Demo image placeholder"],
                ["presentation.pptx", "Demo presentation"],
                ["archive.zip", "Demo archive placeholder"],
                ["still-downloading.pdf.crdownload", "Demo partial download"],
                ["read-me.unknown", "Unmatched demo file"],
              ]) {
                const path = join(root, name);
                await fs.writeFile(path, text);
                const ago = new Date(Date.now() - 60000);
                await fs.utimes(path, ago, ago);
              }
              config.root = root;
              preview = null;
              seen = new Map();
              await persist();
              return await state();
            });
            break;
          case "/api/rules":
            result = await exclusive(async () => {
              const rules = validateRules(body.rules);
              automatic = false;
              config.rules = rules;
              preview = null;
              await persist();
              return await state();
            });
            break;
          case "/api/preview":
            result = await exclusive(async () => {
              if (!config.root) throw Error("Choose a folder first.");
              preview = await scanFolder(config.root, {
                rules: config.rules,
                minimumAgeMs: settleMs,
              });
              return preview;
            });
            break;
          case "/api/sort":
            result = await exclusive(async () => {
              if (
                !preview ||
                preview.id !== body.id ||
                Date.now() - Date.parse(preview.created_at) > 600000
              )
                throw Error("Create a fresh preview first.");
              const plan = preview;
              preview = null;
              const run = await applyPlan(plan);
              for (const e of run.moves)
                if (e.phase === "moved") seen.set(e.name, e.signature);
              return run;
            });
            break;
          case "/api/undo":
            result = await exclusive(async () => {
              if (!config.root) throw Error("Choose a folder first.");
              const run = await undoRun(config.root, body.id);
              for (const e of run.moves)
                if (e.phase === "undone") seen.set(e.name, e.signature);
              preview = null;
              return run;
            });
            break;
          case "/api/automatic":
            result = await exclusive(async () => {
              if (typeof body.enabled !== "boolean")
                throw Error("Choose on or off.");
              if (body.enabled) {
                if (!config.root) throw Error("Choose a folder first.");
                seen = await snapshot(config.root);
                automatic = true;
                lastError = null;
                preview = null;
              } else automatic = false;
              return await state();
            });
            break;
          default:
            return reply(res, 404, { error: "Unknown operation." });
        }
        return reply(res, 200, result);
      }
      if (req.method !== "GET")
        return reply(res, 405, { error: "Method not allowed." });
      const publicRoot = join(here, "public"),
        requested = decodeURIComponent(url.pathname),
        path = resolve(
          publicRoot,
          "." + (requested === "/" ? "/index.html" : requested),
        );
      if (!path.startsWith(publicRoot + sep))
        return reply(res, 404, { error: "Not found." });
      let bytes = await fs.readFile(path);
      if (path.endsWith("index.html"))
        bytes = Buffer.from(
          bytes.toString("utf8").replace("__LOCAL_TOKEN__", token),
        );
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html; charset=utf-8",
            ".mjs": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
            ".svg": "image/svg+xml",
          }[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      });
      res.end(bytes);
    } catch (e) {
      reply(res, e.code === "ENOENT" ? 404 : 400, { error: e.message });
    }
  });
  server.on("close", () => clearInterval(timer));
  return {
    server,
    tick,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
if (
  process.argv[1] &&
  (await fs.realpath(resolve(process.argv[1])).catch(() => null)) ===
    fileURLToPath(import.meta.url)
) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw Error("Install Node.js 22 or later.");
  const app = await createApp();
  app.server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? "The local port is in use. Close the previous Downloads Sorter launcher, then try again."
        : e.message,
    );
    process.exitCode = 1;
  });
  app.server.listen(Number(process.env.PORT || 4494), "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + app.server.address().port;
    console.log(
      "Downloads Sorter: " +
        url +
        "\nClose this window or press Ctrl+C to stop automatic sorting.",
    );
    if (process.argv.includes("--open")) {
      const command =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "cmd.exe"
              : "xdg-open",
        args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      execFile(command, args, (error) => {
        if (error) console.log("Open the local URL above in your browser.");
      });
    }
  });
}
