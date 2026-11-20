const $ = (s) => document.querySelector(s),
  token = $("meta[name=local-token]").content;
let state = null,
  plan = null,
  working = false,
  defaults = null;
function node(tag, text, css) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (css) n.className = css;
  return n;
}
function status(text, error = false) {
  $("#status").textContent = text;
  $("#status").dataset.error = String(error);
}
async function api(name, body) {
  const r = await fetch("/api/" + name, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Local-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "Operation failed.");
  return value;
}
async function action(fn) {
  if (working) return;
  working = true;
  buttons();
  try {
    await fn();
  } catch (e) {
    status(e.message, true);
  } finally {
    working = false;
    await refresh().catch(() => {});
    buttons();
  }
}
function buttons() {
  for (const id of [
    "choose",
    "demo",
    "preview",
    "sort",
    "automatic",
    "save-rules",
  ])
    $("#" + id).disabled =
      working || (["preview", "automatic"].includes(id) && !state?.root);
  $("#sort").disabled = working || !plan?.moves.length;
}
function tab(name) {
  for (const n of ["preview", "history", "rules"])
    $("#" + n + "-panel").hidden = n !== name;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === name)),
    );
}
document
  .querySelectorAll("[data-tab]")
  .forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
function folderTitle(root) {
  if (!root) return "Choose a folder";
  const name = root.split(/[\\/]/).filter(Boolean).at(-1);
  return name.startsWith("demo-") ? "Demo folder" : name;
}
async function refresh() {
  state = await api("state");
  $("#folder-title").textContent = folderTitle(state.root);
  $("#folder-path").value = state.root || "";
  $("#folder-summary").textContent = state.root
    ? "Preview the destinations below before sorting existing files."
    : "Nothing moves until you review a preview or turn on automatic sorting.";
  $("#folder-path").placeholder = state.suggestedFolder;
  $("#auto-state").textContent = state.automatic ? "On" : "Off";
  $("#automatic").textContent = state.automatic ? "Turn off" : "Turn on";
  $("#last-error").textContent = state.lastError || "";
  renderHistory();
  buttons();
}
function clearPlan() {
  plan = null;
  $("#file-list").replaceChildren();
  $("#skipped").replaceChildren();
  $("#empty").hidden = false;
  $("#empty p").textContent = state?.root
    ? "Select Preview sorting."
    : "Choose a folder or try the demo.";
  $("#approve-bar").hidden = true;
  $("#preview-title").textContent = "Files";
}
function renderPreview() {
  const list = $("#file-list");
  list.replaceChildren();
  $("#empty").hidden = !!plan.moves.length;
  $("#empty p").textContent = "No files are ready to sort.";
  $("#preview-title").textContent = plan.moves.length + " ready";
  for (const move of plan.moves) {
    const row = node("div", undefined, "file-row"),
      icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 25 31");
    icon.setAttribute("class", "file-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<path d="M3 1h12l7 7v22H3zM15 1v8h7M7 16h10M7 21h8"/>';
    const name = node("div");
    name.append(
      node("p", move.name, "file-name"),
      node(
        "p",
        move.size < 1024
          ? move.size + " B"
          : (move.size / 1024).toFixed(1) + " KB",
        "file-size",
      ),
    );
    const target = node("p", move.target.split("/")[0], "file-target");
    if (move.target.split("/")[1] !== move.name)
      target.append(node("small", "Saved as " + move.target.split("/")[1]));
    row.append(icon, name, target);
    list.append(row);
  }
  $("#skipped").replaceChildren();
  if (plan.skipped.length) {
    const details = node("details"),
      summary = node("summary", plan.skipped.length + " left in place");
    details.append(summary);
    for (const entry of plan.skipped)
      details.append(node("p", entry.name + " · " + entry.reason));
    $("#skipped").append(details);
  }
  $("#approve-bar").hidden = !plan.moves.length;
  $("#move-count").textContent = plan.moves.length + " files will move";
  buttons();
}
function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  if (!state.runs.length) {
    list.append(node("div", "No sorting runs yet.", "run"));
    return;
  }
  for (const run of state.runs.slice(0, 30)) {
    const moved = run.moves.filter((e) => e.phase === "moved").length,
      undone = run.moves.filter((e) => e.phase === "undone").length,
      skipped = run.moves.filter((e) => e.phase === "skipped").length,
      block = node("article", undefined, "run"),
      head = node("div", undefined, "run-heading"),
      text = node("div");
    text.append(
      node(
        "h3",
        run.state === "undone"
          ? "Restored " + undone + " files"
          : moved + " files sorted",
      ),
      node(
        "p",
        new Date(run.created_at).toLocaleString() +
          (skipped ? " · " + skipped + " skipped" : ""),
      ),
    );
    head.append(text);
    if (run.moves.some((e) => ["moved", "planned"].includes(e.phase))) {
      const undo = node("button", "Undo run", "secondary");
      undo.disabled = working || state.busy;
      undo.onclick = () =>
        action(async () => {
          const result = await api("undo", { id: run.id });
          clearPlan();
          status(
            result.state === "undone"
              ? "Files restored."
              : "Some files could not be restored. See the run details.",
          );
        });
      head.append(undo);
    }
    block.append(head);
    const details = node("details");
    details.append(node("summary", "Run details"));
    for (const e of run.moves)
      details.append(
        node(
          "p",
          e.name +
            " · " +
            e.phase +
            (e.undo_error
              ? " · " + e.undo_error
              : e.error
                ? " · " + e.error
                : ""),
        ),
      );
    block.append(details);
    list.append(block);
  }
}
function renderRules(rules) {
  const list = $("#rule-list");
  list.replaceChildren();
  for (const rule of rules) {
    const row = node("div", undefined, "rule-row");
    for (const [key, label, value] of [
      ["folder", "Destination folder", rule.folder],
      ["extensions", "Extensions", rule.extensions.join(", ")],
      ["contains", "Filename contains", rule.contains.join(", ")],
    ]) {
      const l = node("label", label),
        input = node("input");
      input.dataset.key = key;
      input.value = value;
      input.maxLength = key === "folder" ? 40 : 1000;
      l.append(input);
      row.append(l);
    }
    const remove = node("button", "×", "remove-rule");
    remove.setAttribute("aria-label", "Remove " + rule.folder + " rule");
    remove.onclick = () => row.remove();
    row.append(remove);
    list.append(row);
  }
}
$("#choose").onclick = () =>
  action(async () => {
    const result = await api("pick", {});
    if (result.path) {
      state = await api("folder", { path: result.path });
      clearPlan();
      status("Folder selected. Create a preview before moving existing files.");
    } else {
      $(".path-editor").open = true;
      $("#folder-path").focus();
      status(result.message || "Paste the full folder path.");
    }
  });
$("#path-form").onsubmit = (e) => {
  e.preventDefault();
  const path = $("#folder-path").value;
  void action(async () => {
    state = await api("folder", { path });
    clearPlan();
    $(".path-editor").open = false;
    status("Folder selected. Nothing moved.");
  });
};
$("#demo").onclick = () =>
  action(async () => {
    state = await api("demo", {});
    clearPlan();
    plan = await api("preview", {});
    renderPreview();
    tab("preview");
    status("Demo files only. Your Downloads folder is untouched.");
  });
$("#preview").onclick = () =>
  action(async () => {
    plan = await api("preview", {});
    renderPreview();
    status("Preview ready. No files moved.");
  });
$("#sort").onclick = () =>
  action(async () => {
    const result = await api("sort", { id: plan.id });
    const moved = result.moves.filter((e) => e.phase === "moved").length;
    clearPlan();
    tab("history");
    status(moved + " files sorted. Undo is available in History.");
  });
$("#automatic").onclick = () =>
  action(async () => {
    await api("automatic", { enabled: !state.automatic });
    clearPlan();
    status(
      state.automatic
        ? "Automatic sorting stopped."
        : "Automatic sorting enabled for new files. Existing files stay put.",
    );
  });
$("#refresh-history").onclick = () =>
  action(async () => {
    await refresh();
    status("History refreshed.");
  });
$("#save-rules").onclick = () =>
  action(async () => {
    const rules = [...document.querySelectorAll(".rule-row")].map((row) => {
      const value = (k) => row.querySelector(`[data-key=${k}]`).value;
      return {
        folder: value("folder").trim(),
        extensions: value("extensions")
          .split(",")
          .map((x) => x.trim().replace(/^\./, ""))
          .filter(Boolean),
        contains: value("contains")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
    });
    await api("rules", { rules });
    clearPlan();
    status("Rules saved. Automatic mode is off. Review a fresh preview.");
  });
$("#add-rule").onclick = () => {
  const rows = [...document.querySelectorAll(".rule-row")].map((row) => ({
    folder: row.querySelector("[data-key=folder]").value,
    extensions: row
      .querySelector("[data-key=extensions]")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    contains: row
      .querySelector("[data-key=contains]")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
  renderRules([
    ...rows,
    { folder: "New folder", extensions: ["pdf"], contains: [] },
  ]);
};
$("#default-rules").onclick = () => renderRules(defaults);
$("#help").onclick = () => $("#help-dialog").showModal();
$("#close-help").onclick = () => $("#help-dialog").close();
try {
  await refresh();
  defaults = structuredClone(state.defaultRules);
  renderRules(state.rules);
} catch (e) {
  status(e.message, true);
}
setInterval(() => {
  if (!working)
    void refresh().catch((e) =>
      status("Local app disconnected. Reopen the launcher.", true),
    );
}, 5000);
