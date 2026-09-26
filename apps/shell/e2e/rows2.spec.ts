import { expect, test, type Page } from "@playwright/test";

const win = (page: Page, app: string) => page.locator(`section.win[data-app="${app}"]`);
const menu = async (page: Page, title: string, item: string | RegExp) => {
  await page.locator(".menu > .menu-title", { hasText: title }).first().dispatchEvent("pointerdown");
  await page.locator(".menu.open .menu-items button", { hasText: item }).first().click();
};
const U = { actor: { kind: "user", id: "user" } } as const;
const exists = (page: Page, path: string) =>
  page.evaluate(([p]) => window.cauldron.shell.kernel.vfs.exists({ actor: { kind: "user", id: "user" } }, p!), [path]);
const read = (page: Page, path: string) =>
  page.evaluate(([p]) => window.cauldron.shell.kernel.vfs.read({ actor: { kind: "user", id: "user" } }, p!).content, [path]);
void U;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(win(page, "finder").first()).toBeVisible();
});

/** Two Finder windows side by side: A on /Documents (left), B on /Shared (right). */
async function twoFinders(page: Page) {
  await menu(page, "✦", "New Finder Window");
  await menu(page, "Go", "Shared");
  await page.evaluate(() => {
    const { wm } = window.cauldron.shell.kernel;
    const [a, b] = wm.list().filter((w) => w.appId === "finder");
    const u = { actor: { kind: "user" as const, id: "user" } };
    wm.move(u, a!.id, 20, 60);
    wm.move(u, b!.id, 660, 60);
  });
  return [win(page, "finder").nth(0), win(page, "finder").nth(1)] as const;
}

test("FND-04 drag a file to another Finder window moves it; Option/Alt-drag copies", async ({ page }) => {
  const [a, b] = await twoFinders(page);
  await expect(a.locator(".path")).toHaveText("/Documents");
  await expect(b.locator(".path")).toHaveText("/Shared");

  await a.locator('tr[data-name="Welcome.txt"]').dragTo(b.locator(".scroll"));
  await expect(b.locator('tr[data-name="Welcome.txt"]')).toBeVisible();
  await expect(a.locator('tr[data-name="Welcome.txt"]')).toHaveCount(0);

  await page.evaluate(() => window.cauldron.shell.kernel.vfs.create({ actor: { kind: "user", id: "user" } }, "/Documents/keep.txt", "file", { content: "k" }));
  await page.keyboard.down("Alt");
  await a.locator('tr[data-name="keep.txt"]').dragTo(b.locator(".scroll"));
  await page.keyboard.up("Alt");
  await expect(b.locator('tr[data-name="keep.txt"]')).toBeVisible();
  await expect(a.locator('tr[data-name="keep.txt"]')).toBeVisible();
  expect(await read(page, "/Shared/keep.txt")).toBe("k");
});

test("FND-04b dropping onto a folder row moves the file into that folder", async ({ page }) => {
  const f = win(page, "finder").first();
  await page.evaluate(() => window.cauldron.shell.kernel.vfs.create({ actor: { kind: "user", id: "user" } }, "/Documents/Plans", "folder"));
  await f.locator('tr[data-name="Welcome.txt"]').dragTo(f.locator('tr[data-name="Plans"]'));
  expect(await exists(page, "/Documents/Plans/Welcome.txt")).toBe(true);
});

test("FND-07 desktop shows /Desktop as icons; dropping an icon on Trash trashes it and fills the Trash", async ({ page }) => {
  const trash = page.locator('.desk-icon.trash');
  await expect(trash).toHaveAttribute("data-full", "false");
  await page.evaluate(() => window.cauldron.shell.kernel.vfs.create({ actor: { kind: "user", id: "user" } }, "/Desktop/notes.txt", "file", { content: "n" }));
  const icon = page.locator('.desk-icon[data-name="notes.txt"]');
  await expect(icon).toBeVisible();
  await icon.dragTo(trash);
  await expect(icon).toHaveCount(0);
  await expect(trash).toHaveAttribute("data-full", "true");
  expect(await exists(page, "/Trash/notes.txt")).toBe(true);
});

test("FND-07b dragging a Finder row onto the desktop moves it to /Desktop; double-click opens it", async ({ page }) => {
  const f = win(page, "finder").first();
  await f.locator('tr[data-name="Welcome.txt"]').dragTo(page.locator("#desktop-icons"), { targetPosition: { x: 60, y: 600 } });
  const icon = page.locator('.desk-icon[data-name="Welcome.txt"]');
  await expect(icon).toBeVisible();
  expect(await exists(page, "/Desktop/Welcome.txt")).toBe(true);
  await icon.dblclick();
  await expect(win(page, "textedit").first().locator("textarea")).toHaveValue(/^Welcome\./);
});

test("TXT-03 three edits, Undo ×3, Redo ×3 — content matches at each step", async ({ page }) => {
  await menu(page, "✦", "New TextEdit Document");
  const t = win(page, "textedit").first().locator("textarea");
  await t.fill("a");
  await t.fill("ab");
  await t.fill("abc");
  for (const want of ["ab", "a", ""]) {
    await page.keyboard.press("ControlOrMeta+z");
    await expect(t).toHaveValue(want);
  }
  for (const want of ["a", "ab", "abc"]) {
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(t).toHaveValue(want);
  }
});

test("TXT-03b history holds at least 100 steps", async ({ page }) => {
  await menu(page, "✦", "New TextEdit Document");
  const t = win(page, "textedit").first().locator("textarea");
  await t.evaluate((el: HTMLTextAreaElement) => {
    for (let i = 0; i < 120; i++) {
      el.value += "x";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  });
  await t.focus();
  for (let i = 0; i < 105; i++) await page.keyboard.press("ControlOrMeta+z");
  await expect(t).toHaveValue("x".repeat(15));
});

test("TXT-04 renaming the open file in Finder retitles TextEdit; Save writes to the new path", async ({ page }) => {
  const f = win(page, "finder").first();
  await f.locator('tr[data-name="Welcome.txt"]').dblclick();
  const te = win(page, "textedit").first();
  await expect(te.locator(".title")).toHaveText("Welcome.txt");
  await menu(page, "Window", "Documents"); // raise Finder; TextEdit sits on top of it
  await expect(f).toHaveAttribute("data-focused", "true");
  await f.locator('tr[data-name="Welcome.txt"]').click();
  await menu(page, "File", "Rename");
  await f.locator("input.rename").fill("Hello.txt");
  await f.locator("input.rename").press("Enter");
  await expect(te.locator(".title")).toHaveText("Hello.txt");
  await menu(page, "Window", "Hello.txt");
  await te.locator("textarea").fill("renamed, then saved");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(te.locator(".title")).toHaveText("Hello.txt");
  expect(await read(page, "/Documents/Hello.txt")).toBe("renamed, then saved");
  expect(await exists(page, "/Documents/Welcome.txt")).toBe(false);
});

test("TXT-06 Find shows the match count; Enter cycles and wraps", async ({ page }) => {
  await menu(page, "✦", "New TextEdit Document");
  const te = win(page, "textedit").first();
  const t = te.locator("textarea");
  await t.fill("foo bar foo baz FOO");
  await page.keyboard.press("ControlOrMeta+f");
  const find = te.getByRole("textbox", { name: "Find" });
  await expect(find).toBeFocused();
  await find.fill("foo");
  const count = te.locator(".findbar .count");
  await expect(count).toHaveText("1 of 3");
  await find.press("Enter");
  await expect(count).toHaveText("2 of 3");
  expect(await t.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([8, 11]);
  await find.press("Enter");
  await find.press("Enter");
  await expect(count).toHaveText("1 of 3");
  await find.fill("zzz");
  await expect(count).toHaveText("No matches");
  await find.press("Escape");
  await expect(te.locator(".findbar")).toHaveCount(0);
});

test("TXT-04b a case-only rename of the open file does not raise a false conflict", async ({ page }) => {
  await win(page, "finder").first().locator('tr[data-name="Welcome.txt"]').dblclick();
  const te = win(page, "textedit").first();
  await page.evaluate(() => window.cauldron.shell.kernel.vfs.rename({ actor: { kind: "user", id: "user" } }, "/Documents/Welcome.txt", "WELCOME.txt"));
  await expect(te.locator(".title")).toHaveText("WELCOME.txt");
  await expect(te.locator(".banner")).toBeHidden();
  await te.locator("textarea").fill("still mine");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(te.locator(".title")).toHaveText("WELCOME.txt");
  expect(await read(page, "/Documents/WELCOME.txt")).toBe("still mine");
});

test("TXT-06b every match is highlighted; the current one is marked", async ({ page }) => {
  await menu(page, "✦", "New TextEdit Document");
  const te = win(page, "textedit").first();
  await te.locator("textarea").fill("foo bar foo baz FOO");
  await page.keyboard.press("ControlOrMeta+f");
  await te.getByRole("textbox", { name: "Find" }).fill("foo");
  await expect(te.locator(".hl mark")).toHaveCount(3);
  await te.getByRole("textbox", { name: "Find" }).press("Enter");
  await expect(te.locator(".hl mark.current")).toHaveText("foo");
  expect(await te.locator(".hl mark").evaluateAll((ms) => ms.findIndex((m) => m.classList.contains("current")))).toBe(1);
  await te.getByRole("textbox", { name: "Find" }).press("Escape");
  await expect(te.locator(".hl mark")).toHaveCount(0);
});
