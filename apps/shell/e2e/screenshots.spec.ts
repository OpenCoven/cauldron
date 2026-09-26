import { expect, test } from "@playwright/test";

// Visual acceptance captures. Opt-in: SHOTS_DIR=/abs/path npx playwright test screenshots
const dir = process.env.SHOTS_DIR;
test.skip(!dir, "set SHOTS_DIR to capture screenshots");

test("capture: shared desktop with a familiar at work", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const sage = window.cauldron.as("sage");
    await sage.exec("vfs.create", { path: "/Shared/sources.md", kind: "file", content: "# Sources\n- AgentRoom\n- YoloFS\n" });
    await sage.exec("wm.open", { appId: "textedit", instanceId: "sage", documentPath: "/Shared/sources.md", title: "sources.md" });
  });
  await page.locator('section.win[data-app="finder"] .toolbar .path').click();
  await page.keyboard.type("/Shared\n");
  await page.locator('tr[data-name="sources.md"]').click();
  await expect(page.locator('section.win[data-owner-kind="agent"] .owner')).toBeVisible();
  await page.screenshot({ path: `${dir}/01-desktop-familiar-window.png` });

  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.locator(".dialog .info")).toBeVisible();
  await page.screenshot({ path: `${dir}/02-get-info-provenance.png` });
  await page.locator(".dialog button").click();

  const pending = page.evaluate(() =>
    window.cauldron.as("sage").exec("vfs.write", { path: "/Documents/Welcome.txt", content: "x", ifRev: 1 }),
  );
  await expect(page.locator('.dialog[data-kind="consent"]')).toBeVisible();
  await page.screenshot({ path: `${dir}/03-consent-dialog.png` });
  await page.locator('.dialog[data-kind="consent"] button', { hasText: "Not now" }).click();
  await pending;
});

test("capture: desktop icons, full Trash, and TextEdit find", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { vfs } = window.cauldron.shell.kernel;
    const u = { actor: { kind: "user" as const, id: "user" } };
    await vfs.create(u, "/Desktop/Ideas", "folder");
    await vfs.create(u, "/Desktop/todo.txt", "file", { content: "foo bar foo baz FOO" });
    await vfs.create(u, "/Desktop/old.txt", "file");
    await vfs.trash(u, "/Desktop/old.txt");
  });
  await page.locator('.desk-icon[data-name="todo.txt"]').dblclick();
  const te = page.locator('section.win[data-app="textedit"]').first();
  await expect(te.locator("textarea")).toHaveValue(/foo/);
  await page.keyboard.press("ControlOrMeta+f");
  await te.getByRole("textbox", { name: "Find" }).fill("foo");
  await te.getByRole("textbox", { name: "Find" }).press("Enter");
  await page.screenshot({ path: `${dir}/05-desktop-icons-find.png` });
});

test("capture: Finder icon view with a marquee selection in progress", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { vfs } = window.cauldron.shell.kernel;
    const u = { actor: { kind: "user" as const, id: "user" } };
    for (const n of ["brief.md", "notes.txt", "plan.txt", "todo.txt"]) await vfs.create(u, `/Documents/${n}`, "file", { content: n });
    await vfs.create(u, "/Documents/Research", "folder");
    await window.cauldron.as("sage").exec("vfs.create", { path: "/Shared/sources.md", kind: "file", content: "x" });
  });
  const f = page.locator('section.win[data-app="finder"]').first();
  await f.getByRole("button", { name: "Icon view" }).click();
  const a = (await f.locator('.ficon[data-name="brief.md"]').boundingBox())!;
  const c = (await f.locator('.ficon[data-name="plan.txt"]').boundingBox())!;
  await page.mouse.move(a.x + 10, a.y + a.height + 70);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, a.y + 20, { steps: 6 });
  await page.screenshot({ path: `${dir}/06-finder-icon-view-marquee.png` });
  await page.mouse.up();
});
