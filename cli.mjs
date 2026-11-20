#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { scanFolder, applyPlan, undoRun, listRuns } from "./lib/sorter.mjs";
const [command, arg, id, ...rest] = process.argv.slice(2);
try {
  if (command === "preview") {
    if (!arg)
      throw Error(
        "Usage: node cli.mjs preview /path/to/folder [--out preview.json]",
      );
    const plan = await scanFolder(arg),
      args = [id, ...rest],
      out = args.indexOf("--out");
    if (out >= 0) {
      if (!args[out + 1]) throw Error("Provide a filename after --out.");
      await writeFile(args[out + 1], JSON.stringify(plan, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(plan, null, 2));
  } else if (command === "apply") {
    if (!arg) throw Error("Usage: node cli.mjs apply preview.json");
    console.log(
      JSON.stringify(
        await applyPlan(JSON.parse(await readFile(arg, "utf8"))),
        null,
        2,
      ),
    );
  } else if (command === "undo") {
    console.log(JSON.stringify(await undoRun(arg, id), null, 2));
  } else if (command === "history") {
    console.log(JSON.stringify(await listRuns(arg), null, 2));
  } else {
    console.log(
      "Downloads Sorter\n\nnode server.mjs --open\nnode cli.mjs preview /folder --out preview.json\nnode cli.mjs apply preview.json\nnode cli.mjs history /folder\nnode cli.mjs undo /folder RUN_ID\n\nPreview never moves files. Inspect it before applying.",
    );
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
