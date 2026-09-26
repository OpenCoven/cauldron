import { expect, test, type Page } from "@playwright/test";

// Every test starts from a fresh browser context → empty localStorage → first boot.
const win = (page: Page, app: string) => page.locator(`section.win[data-app="${app}"]`);
const finder = (page: Page) => win(page, "finder").first();
const menu = async (page: Page, title: string, item: string | RegExp) => {
  await page.locator(".menu > .menu-title", { hasText: title }).first().dispatchEvent("pointerdown");
  await page.locator(".menu.open .menu-items button", { hasText: item }).first().click();
};
const newTextEdit = (page: Page) => menu(page, "✦", "New TextEdit Document");
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
const sage = (page: Page, op: string, args: Record<string, unknown>) =>
  page.evaluate(([op, args]) => window.cauldron.as("sage").exec(op as string, args as Record<string, unknown>), [op, args] as const);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(finder(page)).toBeVisible();
});

test("WM-01 first boot: menu bar + one Finder window centered at its default size", async ({ page }) => {
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator("section.win")).toHaveCount(1);
  const b = (await finder(page).boundingBox())!;
  expect(Math.round(b.width)).toBe(640);
  expect(Math.round(b.x)).toBe(320);
  expect(Math.round(b.y)).toBe(22 + Math.round((778 - 400) / 2));
  await expect(finder(page)).toHaveAttribute("data-focused", "true");
});

test("WM-02 second window cascades +24/+24; clicking the first raises and focuses it", async ({ page }) => {
  await newTextEdit(page);
  await newTextEdit(page);
  const [a, b] = [win(page, "textedit").nth(0), win(page, "textedit").nth(1)];
  const ba = (await a.boundingBox())!, bb = (await b.boundingBox())!;
  expect(Math.round(bb.x - ba.x)).toBe(24);
  expect(Math.round(bb.y - ba.y)).toBe(24);
  await a.locator(".title").click();
  await expect(a).toHaveAttribute("data-focused", "true");
  const z = async (l: typeof a) => Number(await l.evaluate((el) => (el as HTMLElement).style.zIndex));
  expect(await z(a)).toBeGreaterThan(await z(b));
});

test("WM-03 dragging above the menu bar stops flush under it", async ({ page }) => {
  const t = await box(page, 'section.win[data-app="finder"] .title');
  await page.mouse.move(t.x + 5, t.y + 5);
  await page.mouse.down();
  await page.mouse.move(t.x + 5, t.y - 400, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await finder(page).boundingBox())!.y)).toBe(22);
});

test("WM-04 resizing below the minimum clamps to minSize", async ({ page }) => {
  await newTextEdit(page);
  const te = win(page, "textedit").first();
  const h = (await te.locator(".resize").boundingBox())!;
  await page.mouse.move(h.x + 8, h.y + 8);
  await page.mouse.down();
  await page.mouse.move(h.x - 900, h.y - 900, { steps: 5 });
  await page.mouse.up();
  const b = (await te.boundingBox())!;
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([320, 200]);
});

test("WM-05 minimize hides; choosing it from the Window menu restores and focuses", async ({ page }) => {
  await finder(page).locator("button.min").click();
  await expect(finder(page)).toBeHidden();
  await menu(page, "Window", "Documents");
  await expect(finder(page)).toBeVisible();
  await expect(finder(page)).toHaveAttribute("data-focused", "true");
});

test("WM-06 closing a dirty document asks; Cancel keeps it open", async ({ page }) => {
  await newTextEdit(page);
  const te = win(page, "textedit").first();
  await te.locator("textarea").fill("half a thought");
  await page.keyboard.press("ControlOrMeta+w");
  const d = page.locator(".dialog");
  await expect(d).toContainText("Do you want to save");
  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(te).toBeVisible();
});

test("WM-07 reload restores windows, rects, z-order and focus", async ({ page }) => {
  await newTextEdit(page);
  const snap = () => page.evaluate(() => window.cauldron.shell.kernel.wm.snapshot());
  const before = await snap();
  await page.reload();
  await expect(page.locator("section.win")).toHaveCount(2);
  const after = await snap();
  expect(after.stack).toEqual(before.stack);
  expect(after.focusedId).toEqual(before.focusedId);
  expect(after.windows.map((w) => w.rect)).toEqual(before.windows.map((w) => w.rect));
});

test("WM-08 small viewport: windows fill the desktop area and cannot be resized", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const b = (await finder(page).boundingBox())!;
  expect([Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]).toEqual([0, 22, 500, 778]);
  await expect(finder(page).locator(".resize")).toBeHidden();
});

test("WM-09 a familiar's window opens behind, badged, with owner and status; focus stays", async ({ page }) => {
  const r = await sage(page, "wm.open", { appId: "textedit", instanceId: "sage-1", title: "Sage's notes" });
  expect(r).toMatchObject({ ok: true });
  const theirs = win(page, "textedit").first();
  await expect(theirs).toHaveAttribute("data-owner-kind", "agent");
  await expect(theirs.locator(".owner")).toHaveText("Sage · working");
  await expect(theirs.locator(".badge")).toBeVisible();
  await expect(finder(page)).toHaveAttribute("data-focused", "true");
});

test("FND-01 double-click a folder to enter it; Back returns", async ({ page }) => {
  const f = finder(page);
  await f.getByRole("button", { name: "Enclosing Folder" }).click();
  await expect(f.locator(".path")).toHaveText("/");
  await f.locator('tr[data-name="Documents"]').dblclick();
  await expect(f.locator(".path")).toHaveText("/Documents");
  await f.getByRole("button", { name: "Back" }).click();
  await expect(f.locator(".path")).toHaveText("/");
});

test("FND-02 New Folder starts in rename mode; Enter commits the name", async ({ page }) => {
  const f = finder(page);
  await f.getByRole("button", { name: "New Folder" }).click();
  const input = f.locator("input.rename");
  await expect(input).toHaveValue("untitled folder");
  await input.fill("Plans");
  await input.press("Enter");
  await expect(f.locator('tr[data-name="Plans"]')).toBeVisible();
  await expect(f.locator('tr[data-name="untitled folder"]')).toHaveCount(0);
});

test("FND-03 clicking Modified twice sorts newest first", async ({ page }) => {
  await page.evaluate(async () => {
    const { vfs } = window.cauldron.shell.kernel;
    const u = { actor: { kind: "user", id: "user" } } as const;
    await vfs.create(u, "/Documents/older.txt", "file");
    await new Promise((r) => setTimeout(r, 15));
    await vfs.create(u, "/Documents/newer.txt", "file");
  });
  const f = finder(page);
  await f.locator('th[data-sort="modified"]').click();
  await f.locator('th[data-sort="modified"]').click();
  await expect(f.locator("tbody tr").first()).toHaveAttribute("data-name", "newer.txt");
});

test("FND-05 double-clicking Welcome.txt opens it in TextEdit", async ({ page }) => {
  await finder(page).locator('tr[data-name="Welcome.txt"]').dblclick();
  const te = win(page, "textedit").first();
  await expect(te.locator("textarea")).toHaveValue(/^Welcome\./);
  await expect(te.locator(".title")).toHaveText("Welcome.txt");
});

test("FND-06 a rename in one Finder window shows in another within a frame", async ({ page }) => {
  await menu(page, "✦", "New Finder Window");
  const [a, b] = [win(page, "finder").nth(0), win(page, "finder").nth(1)];
  await a.locator(".title").click(); // raise A above the cascaded B
  await a.locator('tr[data-name="Welcome.txt"]').click();
  await menu(page, "File", "Rename");
  const input = a.locator("input.rename");
  await input.fill("Hello.txt");
  await input.press("Enter");
  await expect(b.locator('tr[data-name="Hello.txt"]')).toBeVisible();
});

test("FND-08 Get Info on a familiar's file shows who created and modified it", async ({ page }) => {
  expect(await sage(page, "vfs.create", { path: "/Shared/sources.md", kind: "file", content: "- a source" })).toMatchObject({ ok: true });
  await menu(page, "Go", "Shared");
  const f = finder(page);
  const row = f.locator('tr[data-name="sources.md"]');
  await expect(row.locator("td.by-agent")).toHaveText("Sage");
  await row.click();
  await page.keyboard.press("ControlOrMeta+i");
  const d = page.locator(".dialog");
  await expect(d.locator('[data-field="createdBy"]')).toContainText("Sage");
  await expect(d.locator('[data-field="modifiedBy"]')).toContainText("Sage");
});

test("TXT-01 typing marks the title dirty; Save on an untitled document asks for a name and lands in Finder", async ({ page }) => {
  await newTextEdit(page);
  const te = win(page, "textedit").first();
  await te.locator("textarea").fill("first draft");
  await expect(te.locator(".title")).toHaveText("• Untitled");
  await page.keyboard.press("ControlOrMeta+s");
  const d = page.locator(".dialog");
  await d.locator("input").fill("draft.txt");
  await d.locator("input").press("Enter");
  await expect(te.locator(".title")).toHaveText("draft.txt");
  await expect(finder(page).locator('tr[data-name="draft.txt"]')).toBeVisible();
});

test("TXT-02 edit and save writes the file and advances its revision", async ({ page }) => {
  await finder(page).locator('tr[data-name="Welcome.txt"]').dblclick();
  const te = win(page, "textedit").first();
  await te.locator("textarea").fill("edited");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(te.locator(".title")).toHaveText("Welcome.txt");
  const r = await page.evaluate(() => window.cauldron.shell.kernel.vfs.read({ actor: { kind: "user", id: "user" } }, "/Documents/Welcome.txt"));
  expect(r).toEqual({ content: "edited", rev: 2 });
});

test("TXT-05 unsaved text survives a reload as a dirty draft", async ({ page }) => {
  await newTextEdit(page);
  await win(page, "textedit").first().locator("textarea").fill("do not lose me");
  await page.reload();
  const te = win(page, "textedit").first();
  await expect(te.locator("textarea")).toHaveValue("do not lose me");
  await expect(te.locator(".title")).toHaveText(/^• /);
});

test("VFS-07 (UI) a familiar writing outside its folder asks; Not now leaves the file alone", async ({ page }) => {
  const pending = sage(page, "vfs.write", { path: "/Documents/Welcome.txt", content: "sage was here", ifRev: 1 });
  const d = page.locator('.dialog[data-kind="consent"]');
  await expect(d).toContainText("Sage wants to change /Documents/Welcome.txt");
  await d.getByRole("button", { name: "Not now" }).click();
  expect(await pending).toMatchObject({ ok: false, error: "E_CONSENT" });
  const r = await page.evaluate(() => window.cauldron.shell.kernel.vfs.read({ actor: { kind: "user", id: "user" } }, "/Documents/Welcome.txt"));
  expect(r.rev).toBe(1);
});

test("TXT-07 a familiar rewrites the open file: banner names them; Reload shows their text", async ({ page }) => {
  await finder(page).locator('tr[data-name="Welcome.txt"]').dblclick();
  const te = win(page, "textedit").first();
  await expect(te.locator("textarea")).toHaveValue(/^Welcome\./);
  const pending = sage(page, "vfs.write", { path: "/Documents/Welcome.txt", content: "Rewritten by Sage.", ifRev: 1 });
  await page.locator('.dialog[data-kind="consent"]').getByRole("button", { name: "Allow" }).click();
  expect(await pending).toMatchObject({ ok: true });
  await expect(te.locator(".banner")).toContainText("Changed by Sage.");
  await te.locator(".banner").getByRole("button", { name: "Reload" }).click();
  await expect(te.locator("textarea")).toHaveValue("Rewritten by Sage.");
  await expect(te.locator(".banner")).toBeHidden();
});
