import { test } from "node:test";
import assert from "node:assert/strict";
import { USER, agent } from "../src/index.ts";
import { FINDER, TEXTEDIT, setup } from "./helpers.ts";

const u = { actor: USER };
const sage = { actor: agent("sage") };
const openTE = (k: ReturnType<typeof setup>["k"], ctx = u) =>
  k.wm.open(ctx, { instanceId: "i", appId: "textedit", title: "Untitled", defaultSize: TEXTEDIT.defaultWindow, minSize: TEXTEDIT.minWindow });

test("WM-01 first window is centered in the desktop area at defaultWindow", () => {
  const { k } = setup({ viewport: { w: 1280, h: 800 } });
  const w = k.wm.open(u, { instanceId: "f", appId: "finder", title: "Documents", defaultSize: FINDER.defaultWindow, minSize: FINDER.minWindow });
  const area = k.wm.desktopArea;
  assert.deepEqual(area, { x: 0, y: 22, w: 1280, h: 778 });
  assert.deepEqual(w.rect, { x: 320, y: 22 + Math.round((778 - 420) / 2), w: 640, h: 420 });
  assert.equal(k.wm.focusedId, w.id);
});

test("WM-02 second window cascades +24/+24; clicking the first raises and focuses it", () => {
  const { k } = setup();
  const a = openTE(k);
  const b = openTE(k);
  assert.equal(b.rect.x, a.rect.x + 24);
  assert.equal(b.rect.y, a.rect.y + 24);
  assert.equal(k.wm.focusedId, b.id);
  k.wm.focus(u, a.id);
  assert.equal(k.wm.focusedId, a.id);
  assert.ok(k.wm.z(a.id) > k.wm.z(b.id));
});

test("WM-02b cascade restarts centered when it would leave the desktop area", () => {
  const { k } = setup({ viewport: { w: 600, h: 440 } });
  const a = openTE(k);
  const b = openTE(k);
  assert.deepEqual([b.rect.x, b.rect.y], [a.rect.x, a.rect.y]);
});

test("WM-03 dragging above the menu bar stops flush under it; 40px of title stays visible", () => {
  const { k } = setup();
  const w = openTE(k);
  assert.equal(k.wm.move(u, w.id, 100, -50).y, 22);
  assert.equal(k.wm.move(u, w.id, -10_000, 100).x, 40 - w.rect.w);
  assert.equal(k.wm.move(u, w.id, 10_000, 100).x, 1280 - 40);
  assert.equal(k.wm.move(u, w.id, 100, 10_000).y, 800 - 20);
});

test("WM-04 resize below minSize clamps", () => {
  const { k } = setup();
  const w = openTE(k);
  assert.deepEqual(k.wm.resize(u, w.id, 10, 10), { ...w.rect, w: 320, h: 200 });
});

test("WM-05 minimize hides and refocuses; restore via focus", () => {
  const { k } = setup();
  const a = openTE(k);
  const b = openTE(k);
  k.wm.minimize(u, b.id);
  assert.equal(k.wm.get(b.id).state, "minimized");
  assert.equal(k.wm.focusedId, a.id);
  k.wm.focus(u, b.id);
  assert.equal(k.wm.get(b.id).state, "normal");
  assert.equal(k.wm.focusedId, b.id);
});

test("WM-07 snapshot → restore keeps windows, rects, z-order, focus, owners", () => {
  const { k } = setup();
  const a = openTE(k);
  const b = openTE(k, sage);
  k.wm.move(u, a.id, 50, 60);
  const snap = JSON.parse(JSON.stringify(k.wm.snapshot()));
  const { k: k2 } = setup();
  k2.wm.restore(snap);
  assert.deepEqual(k2.wm.snapshot(), k.wm.snapshot());
  assert.deepEqual(k2.wm.get(b.id).ownerActor, agent("sage"));
});

test("WM-08 small viewport: windows fill the desktop area; drag and resize are no-ops", () => {
  const { k } = setup({ viewport: { w: 500, h: 800 } });
  const w = openTE(k);
  assert.deepEqual(w.rect, k.wm.desktopArea);
  assert.deepEqual(k.wm.move(u, w.id, 5, 300), w.rect);
  assert.deepEqual(k.wm.resize(u, w.id, 900, 900), w.rect);
});

test("WM-09 agent-opened window opens behind the focused window, badged, owner+status set, focus unchanged", () => {
  const { k, events } = setup();
  const mine = openTE(k);
  const theirs = openTE(k, sage);
  assert.equal(k.wm.focusedId, mine.id);
  assert.equal(k.wm.z(theirs.id), k.wm.z(mine.id) - 1);
  assert.equal(theirs.badge, true);
  assert.deepEqual(theirs.ownerActor, agent("sage"));
  assert.equal(theirs.status, "working");
  const opened = events.findLast((e) => e.type === "window:opened")!;
  assert.equal(opened.behind, true);
  // agents may ask for attention, never take focus
  k.wm.focus(sage, theirs.id);
  assert.equal(k.wm.focusedId, mine.id);
  // the user can
  k.wm.focus(u, theirs.id);
  assert.equal(k.wm.focusedId, theirs.id);
  assert.equal(k.wm.get(theirs.id).badge, false);
});

test("WM-09b even intent 'raise' does not steal focus in P0", async () => {
  const { k } = setup();
  k.apps.register(TEXTEDIT);
  const mine = openTE(k);
  const r = await k.commands.execute({ id: "c", actor: agent("sage"), op: "wm.open", args: { appId: "textedit", instanceId: "s", intent: "raise" } });
  assert.equal(r.ok, true);
  assert.equal(k.wm.focusedId, mine.id);
});

test("agent window with nothing focused takes focus (one focused window invariant)", () => {
  const { k } = setup();
  const w = openTE(k, sage);
  assert.equal(k.wm.focusedId, w.id);
});

test("zoom toggles between user rect and desktop area", () => {
  const { k } = setup();
  const w = openTE(k);
  assert.deepEqual(k.wm.zoom(u, w.id), k.wm.desktopArea);
  assert.deepEqual(k.wm.zoom(u, w.id), w.rect);
});

test("close refocuses the next-highest visible window", () => {
  const { k } = setup();
  const a = openTE(k);
  const b = openTE(k);
  k.wm.close(u, b.id);
  assert.equal(k.wm.focusedId, a.id);
  k.wm.close(u, a.id);
  assert.equal(k.wm.focusedId, null);
});
