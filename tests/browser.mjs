import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
const browser = await chromium.launch({
    ...(process.env.SORTER_BROWSER
      ? { executablePath: process.env.SORTER_BROWSER }
      : {}),
    headless: true,
  }),
  checks = [];
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    }),
    errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4494")) external.push(r.url());
  });
  await page.goto("http://127.0.0.1:4494/", { waitUntil: "networkidle" });
  await page.locator("#demo").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".file-row").length === 5,
  );
  const root = await page.locator("#folder-path").inputValue();
  assert.match(root, /[\/]\.local-data[\/]demo-/);
  assert.equal(await page.locator("#folder-title").innerText(), "Demo folder");
  assert.equal(await page.locator("#sort").isEnabled(), true);
  assert.equal(
    await fs.readFile(join(root, "course-notes.pdf"), "utf8"),
    "Demo document",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "docs/desktop.png" });
  checks.push(
    "Demo preview lists five moves and leaves all synthetic source files untouched",
  );
  await page.locator("#sort").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-tab=history]")
        .getAttribute("aria-selected") === "true" &&
      document.querySelector(".run-heading button"),
  );
  assert.equal(
    await fs.readFile(join(root, "Documents", "course-notes.pdf"), "utf8"),
    "Demo document",
  );
  await page.locator(".run-heading button").click();
  await page.waitForFunction(() =>
    document.querySelector(".run h3")?.textContent.startsWith("Restored"),
  );
  assert.equal(
    await fs.readFile(join(root, "course-notes.pdf"), "utf8"),
    "Demo document",
  );
  checks.push(
    "Approved sort moves only demo files; History undo restores their contents",
  );
  await page.locator("#automatic").click();
  await page.waitForFunction(
    () => document.querySelector("#auto-state").textContent === "On",
  );
  await page.locator("#automatic").click();
  await page.waitForFunction(
    () => document.querySelector("#auto-state").textContent === "Off",
  );
  checks.push("Automatic mode can be enabled and stopped explicitly");
  await page.locator("[data-tab=rules]").click();
  await page.locator("[data-key=folder]").first().fill("../escape");
  await page.locator("#save-rules").click();
  await page.waitForFunction(
    () => document.querySelector("#status").dataset.error === "true",
  );
  assert.match(await page.locator("#status").textContent(), /Folder names/);
  await page.locator("#default-rules").click();
  await page.locator("#save-rules").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Rules saved"),
  );
  assert.equal(await page.locator(".rule-row").count(), 8);
  checks.push(
    "Invalid rule destinations are rejected; defaults can be restored and saved",
  );
  await page.locator("[data-tab=preview]").click();
  await page.locator("#preview").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".file-row").length === 5,
  );
  assert.equal(await page.locator("#approve-bar").isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "docs/mobile.png", fullPage: true });
  for (const name of ["rules", "history", "preview"]) {
    await page.locator(`[data-tab=${name}]`).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  checks.push("Preview, History and Rules fit a 390px viewport");
  await page.locator("#help").click();
  assert.equal(await page.locator("dialog").isVisible(), true);
  await page.locator("#close-help").click();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  checks.push("Help works; no uncaught errors or external requests occur");
  await fs.writeFile(
    "docs/browser-results.json",
    JSON.stringify(
      {
        executed_at: new Date().toISOString(),
        checks,
        passed: true,
        limitations:
          "Chromium headless desktop and emulated phone, synthetic files only. Native folder dialogs and Windows/Linux launchers were not executed.",
      },
      null,
      2,
    ),
  );
  console.log(checks);
} finally {
  await browser.close();
}
