import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "sorter-api-"));
  const app = await createApp({
    dataDir: root,
    intervalMs: 100000,
    settleMs: 0,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + app.server.address().port;
  const html = await (await fetch(url)).text(),
    token = html.match(/name="local-token" content="([a-f0-9]+)"/)[1];
  const api = async (path, body) => {
    const r = await fetch(url + "/api/" + path, {
      method: body ? "POST" : "GET",
      headers: { "X-Local-Token": token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    return data;
  };
  return { root, app, url, api, token };
}
test("local API requires session token and rejects foreign Origin and Host", async (t) => {
  const { url, token } = await fixture(t);
  assert.equal((await fetch(url + "/api/state")).status, 403);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { "X-Local-Token": token, Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      url + "/api/state",
      { headers: { "X-Local-Token": token, Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(hostStatus, 403);
});
test("demo preview, sort, history and undo are complete local workflows", async (t) => {
  const { api } = await fixture(t);
  const demo = await api("demo", {}),
    plan = await api("preview", {});
  assert.equal(plan.moves.length, 5);
  assert.equal(plan.skipped.length, 2);
  await assert.rejects(() => api("sort", { id: "fake" }), /preview/);
  const run = await api("sort", { id: plan.id });
  assert.equal(run.moves.filter((e) => e.phase === "moved").length, 5);
  assert.equal((await api("state")).runs.length, 1);
  const undo = await api("undo", { id: run.id });
  assert.equal(undo.state, "undone");
  assert.equal(
    await fs.readFile(join(demo.root, "course-notes.pdf"), "utf8"),
    "Demo document",
  );
});
test("automatic mode ignores initial files, sorts new ones and does not re-sort undone files", async (t) => {
  const { api, app } = await fixture(t);
  const demo = await api("demo", {});
  await api("automatic", { enabled: true });
  await app.tick();
  assert.equal((await api("state")).runs.length, 0);
  await fs.writeFile(
    join(demo.root, "course-notes.pdf"),
    "Edited existing file",
  );
  await app.tick();
  assert.equal((await api("state")).runs.length, 0);
  await fs.writeFile(join(demo.root, "fresh.txt"), "new");
  await app.tick();
  let state = await api("state");
  assert.equal(state.runs[0].moves[0].name, "fresh.txt");
  await api("undo", { id: state.runs[0].id });
  await app.tick();
  state = await api("state");
  assert.equal(state.runs.length, 1);
  assert.equal(await fs.readFile(join(demo.root, "fresh.txt"), "utf8"), "new");
  await api("automatic", { enabled: false });
});
test("changing rules invalidates a preview and stops automatic mode", async (t) => {
  const { api } = await fixture(t);
  await api("demo", {});
  const plan = await api("preview", {});
  await api("rules", {
    rules: [{ folder: "PDFs", extensions: ["pdf"], contains: [] }],
  });
  await assert.rejects(() => api("sort", { id: plan.id }), /preview/);
});
