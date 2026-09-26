import { expect, test, type Page } from "@playwright/test";

const finder = (page: Page) => page.locator('section.win[data-app="finder"]').first();
const menu = async (page: Page, title: string, item: string | RegExp) => {
  await page.locator(".menu > .menu-title", { hasText: title }).first().dispatchEvent("pointerdown");
  await page.locator(".menu.open .menu-items button", { hasText: item }).first().click();
};
const exists = (page: Page, path: string) =>
  page.evaluate(([p]) => window.cauldron.shell.kernel.vfs.exists({ actor: { kind: "user", id: "user" } }, p!), [path]);
const selected = (page: Page) =>
  finder(page).locator("[data-name].selected").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(finder(page)).toBeVisible();
  await page.evaluate(async () => {
    const { vfs } = window.cauldron.shell.kernel;
    const u = { actor: { kind: "user" as const, id: "user" } };
    for (const n of ["a.txt", "b.txt", "c.txt", "d.txt"]) await vfs.create(u, `/Documents/${n}`, "file", { content: n });
    await vfs.create(u, "/Documents/Zed", "folder");
  });
  await expect(finder(page).locator('[data-name="d.txt"]')).toBeVisible();
});

test("FND-09 icon view shows an 80px grid; double-click a folder enters it", async ({ page }) => {
  const f = finder(page);
  await f.getByRole("button", { name: "Icon view" }).click();
  await expect(f.locator(".finder")).toHaveAttribute("data-view", "icon");
  await expect(f.getByRole("button", { name: "Icon view" })).toHaveAttribute("aria-pressed", "true");
  await expect(f.locator(".ficon")).toHaveCount(6);
  const box = (await f.locator('.ficon[data-name="a.txt"]').boundingBox())!;
  expect(Math.round(box.width)).toBe(80);
  await f.locator('.ficon[data-name="Zed"]').dblclick();
  await expect(f.locator(".path")).toHaveText("/Documents/Zed");
});

test("FND-09b view choice persists per folder and across reload", async ({ page }) => {
  const f = finder(page);
  await menu(page, "View", "as Icons");
  await expect(f.locator(".finder")).toHaveAttribute("data-view", "icon");
  await menu(page, "Go", "Shared");
  await expect(f.locator(".finder")).toHaveAttribute("data-view", "list");
  await f.getByRole("button", { name: "Back" }).click();
  await expect(f.locator(".finder")).toHaveAttribute("data-view", "icon");
  await page.reload();
  await expect(finder(page).locator(".finder")).toHaveAttribute("data-view", "icon");
});

test("FND-10 click selects; Shift-click extends a range; ⌘/Ctrl-click toggles", async ({ page }) => {
  const f = finder(page);
  await f.locator('tr[data-name="a.txt"]').click();
  await f.locator('tr[data-name="c.txt"]').click({ modifiers: ["Shift"] });
  expect(await selected(page)).toEqual(["a.txt", "b.txt", "c.txt"]);
  await expect(f.locator(".status")).toHaveText("6 items, 3 selected");
  await f.locator('tr[data-name="b.txt"]').click({ modifiers: ["ControlOrMeta"] });
  expect(await selected(page)).toEqual(["a.txt", "c.txt"]);
  await f.locator('tr[data-name="d.txt"]').click();
  expect(await selected(page)).toEqual(["d.txt"]);
});

test("FND-11 ⌘/Ctrl+A selects all; Move to Trash takes the whole selection", async ({ page }) => {
  const f = finder(page);
  await f.locator('tr[data-name="a.txt"]').click();
  await page.keyboard.press("ControlOrMeta+a");
  expect((await selected(page)).length).toBe(6);
  await f.locator('tr[data-name="a.txt"]').click();
  await f.locator('tr[data-name="b.txt"]').click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ControlOrMeta+Backspace");
  await expect(f.locator('tr[data-name="a.txt"]')).toHaveCount(0);
  await expect(f.locator('tr[data-name="b.txt"]')).toHaveCount(0);
  expect(await exists(page, "/Trash/a.txt")).toBe(true);
  expect(await exists(page, "/Trash/b.txt")).toBe(true);
  expect(await exists(page, "/Documents/c.txt")).toBe(true);
});

test("FND-12 marquee drag in icon view selects the icons it touches", async ({ page }) => {
  const f = finder(page);
  await f.getByRole("button", { name: "Icon view" }).click();
  const b = (await f.locator('.ficon[data-name="b.txt"]').boundingBox())!;
  const c = (await f.locator('.ficon[data-name="c.txt"]').boundingBox())!;
  // Start on empty grid below the first row, drag up-right across b and c.
  await page.mouse.move(b.x + 20, b.y + b.height + 60);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, b.y + 30, { steps: 6 });
  await expect(f.locator(".marquee")).toBeVisible();
  await page.mouse.up();
  await expect(f.locator(".marquee")).toHaveCount(0);
  expect(await selected(page)).toEqual(["b.txt", "c.txt"]);
});

test("FND-13 arrow keys move the selection (list: up/down, icons: left/right)", async ({ page }) => {
  const f = finder(page);
  await f.locator('tr[data-name="a.txt"]').click();
  await page.keyboard.press("ArrowDown");
  expect(await selected(page)).toEqual(["b.txt"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  expect(await selected(page)).toEqual(["b.txt"]);
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selected(page)).toEqual(["b.txt", "c.txt"]);
  await f.getByRole("button", { name: "Icon view" }).click();
  await f.locator('.ficon[data-name="c.txt"]').click();
  await page.keyboard.press("ArrowRight");
  expect(await selected(page)).toEqual(["d.txt"]);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await selected(page)).toEqual(["b.txt"]);
});

test("FND-14 dragging a multi-selection moves every selected item", async ({ page }) => {
  const f = finder(page);
  await f.locator('tr[data-name="a.txt"]').click();
  await f.locator('tr[data-name="c.txt"]').click({ modifiers: ["ControlOrMeta"] });
  await f.locator('tr[data-name="a.txt"]').dragTo(f.locator('tr[data-name="Zed"]'));
  expect(await exists(page, "/Documents/Zed/a.txt")).toBe(true);
  expect(await exists(page, "/Documents/Zed/c.txt")).toBe(true);
  expect(await exists(page, "/Documents/b.txt")).toBe(true);
});

test("FND-15 Open on a multi-selection opens each file in TextEdit", async ({ page }) => {
  const f = finder(page);
  await f.locator('tr[data-name="a.txt"]').click();
  await f.locator('tr[data-name="b.txt"]').click({ modifiers: ["Shift"] });
  await page.keyboard.press("Enter");
  await expect(page.locator('section.win[data-app="textedit"]')).toHaveCount(2);
});
