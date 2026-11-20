import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanFolder,
  applyPlan,
  undoRun,
  listRuns,
  snapshot,
  validateRules,
  hashFile,
} from "../lib/sorter.mjs";
async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "sorter-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("preview never moves files and unknown or partial downloads remain in place", async (t) => {
  const root = await fixture(t);
  for (const name of [
    "photo.PNG",
    "invoice-42.pdf",
    "ongoing.pdf.crdownload",
    "unknown.xyz",
  ])
    await fs.writeFile(join(root, name), name);
  const p = await scanFolder(root, { minimumAgeMs: 0 });
  assert.deepEqual(p.moves.map((m) => m.target).sort(), [
    "Images/photo.PNG",
    "Receipts/invoice-42.pdf",
  ]);
  assert.equal((await fs.readdir(root)).length, 4);
  assert.equal(p.skipped.length, 2);
});
test("sort and undo preserve bytes without overwriting a duplicate name", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(join(root, "Documents"));
  await fs.writeFile(join(root, "Documents", "paper.pdf"), "existing");
  await fs.writeFile(join(root, "paper.pdf"), "original");
  const before = await hashFile(join(root, "paper.pdf")),
    p = await scanFolder(root, { minimumAgeMs: 0 });
  assert.equal(p.moves[0].target, "Documents/paper (2).pdf");
  const run = await applyPlan(p);
  assert.equal(run.moves[0].phase, "moved");
  assert.equal(
    await fs.readFile(join(root, "Documents", "paper.pdf"), "utf8"),
    "existing",
  );
  assert.equal(
    await hashFile(join(root, "Documents", "paper (2).pdf")),
    before,
  );
  const undone = await undoRun(root, run.id);
  assert.equal(undone.state, "undone");
  assert.equal(await hashFile(join(root, "paper.pdf")), before);
});
test("stale preview, newly occupied destination and modified undo target fail safely", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "a.txt"), "one");
  let p = await scanFolder(root, { minimumAgeMs: 0 });
  await fs.writeFile(join(root, "a.txt"), "changed");
  let r = await applyPlan(p);
  assert.equal(r.moves[0].phase, "skipped");
  p = await scanFolder(root, { minimumAgeMs: 0 });
  await fs.writeFile(join(root, "Documents", "a.txt"), "occupied");
  r = await applyPlan(p);
  assert.equal(r.moves[0].phase, "skipped");
  p = await scanFolder(root, { minimumAgeMs: 0 });
  r = await applyPlan(p);
  await fs.writeFile(join(root, r.moves[0].target), "new data");
  const u = await undoRun(root, r.id);
  assert.equal(u.state, "partially-undone");
  assert.match(u.moves[0].undo_error, /changed/);
  assert.equal(
    await fs.readFile(join(root, r.moves[0].target), "utf8"),
    "new data",
  );
});
test("undo does not overwrite a newly created original filename", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "a.pdf"), "original");
  const run = await applyPlan(await scanFolder(root, { minimumAgeMs: 0 }));
  await fs.writeFile(join(root, "a.pdf"), "new original");
  const undo = await undoRun(root, run.id);
  assert.equal(undo.state, "partially-undone");
  assert.equal(await fs.readFile(join(root, "a.pdf"), "utf8"), "new original");
});
test("links, destination links and hidden files are excluded", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await fs.writeFile(join(outside, "secret.pdf"), "private");
  await fs.symlink(join(outside, "secret.pdf"), join(root, "link.pdf"));
  await fs.symlink(outside, join(root, "Images"));
  await fs.writeFile(join(root, "image.png"), "pixels");
  await fs.writeFile(join(root, ".private.pdf"), "hidden");
  const plan = await scanFolder(root, { minimumAgeMs: 0 });
  assert.equal(plan.moves.length, 0);
  assert.equal(
    await fs.readFile(join(outside, "secret.pdf"), "utf8"),
    "private",
  );
});
test("recent files wait and automatic snapshot excludes existing files", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "old.txt"), "old");
  const seen = await snapshot(root);
  await fs.writeFile(join(root, "new.txt"), "new");
  assert.equal((await scanFolder(root)).moves.length, 0);
  const plan = await scanFolder(root, { minimumAgeMs: 0, ignore: seen });
  assert.deepEqual(
    plan.moves.map((e) => e.name),
    ["new.txt"],
  );
});
test("malicious rule paths and forged manifest paths cannot escape the folder", async (t) => {
  assert.throws(() =>
    validateRules([{ folder: "../outside", extensions: ["pdf"] }]),
  );
  assert.throws(() => validateRules([{ folder: "CON", extensions: ["pdf"] }]));
  const root = await fixture(t);
  await fs.writeFile(join(root, "test.pdf"), "safe");
  const plan = await scanFolder(root, { minimumAgeMs: 0 });
  plan.moves[0].target = "../outside.pdf";
  const result = await applyPlan(plan);
  assert.equal(result.moves[0].phase, "skipped");
  assert.equal(await fs.readFile(join(root, "test.pdf"), "utf8"), "safe");
});
test("pending journal with two hard links can recover without deleting original data", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "x.txt"), "x");
  const p = await scanFolder(root, { minimumAgeMs: 0 }),
    r = await applyPlan(p);
  const state = join(root, ".downloads-sorter", r.id + ".json");
  await fs.link(join(root, "Documents", "x.txt"), join(root, "x.txt"));
  r.moves[0].phase = "planned";
  r.state = "running";
  await fs.writeFile(state, JSON.stringify(r));
  const undo = await undoRun(root, r.id);
  assert.equal(undo.state, "undone");
  assert.equal(await fs.readFile(join(root, "x.txt"), "utf8"), "x");
  assert.equal((await listRuns(root)).length, 1);
});
test("pending journal before link creation resolves as not moved", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(join(root, "x.pdf"), "x");
  const p = await scanFolder(root, { minimumAgeMs: 0 }),
    id = p.id;
  await fs.mkdir(join(root, "Documents"));
  await fs.mkdir(join(root, ".downloads-sorter"));
  await fs.writeFile(
    join(root, ".downloads-sorter", id + ".json"),
    JSON.stringify({
      schema: "downloads-sorter-run/1",
      id,
      root: await fs.realpath(root),
      state: "running",
      moves: [{ ...p.moves[0], phase: "planned" }],
    }),
  );
  const undo = await undoRun(root, id);
  assert.equal(undo.state, "undone");
  assert.equal(undo.moves[0].phase, "not-moved");
  assert.equal(await fs.readFile(join(root, "x.pdf"), "utf8"), "x");
});
