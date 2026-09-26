import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError, USER, SYSTEM, agent, MemoryStorage, numberedName } from "../src/index.ts";
import { setup } from "./helpers.ts";

const u = { actor: USER };
const sage = { actor: agent("sage") };
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof KernelError ? e.code : `THROWN ${String(e)}`),
  );

test("first boot layout", () => {
  const { k } = setup();
  const names = k.vfs.list(u, "/").map((s) => s.node.name);
  assert.deepEqual(names, ["Applications", "Desktop", "Documents", "Familiars", "Shared", "Trash"]);
  assert.equal(k.vfs.read(u, "/Documents/Welcome.txt").rev, 1);
  assert.deepEqual(k.vfs.stat(u, "/Documents/Welcome.txt").node.createdBy, SYSTEM);
});

test("VFS-01 create folder, reload, persists with createdBy", async () => {
  const storage = new MemoryStorage();
  const { k } = setup({ storage });
  await k.vfs.create(u, "/Documents/Plans", "folder");
  const { k: k2 } = setup({ storage });
  const st = k2.vfs.stat(u, "/Documents/Plans");
  assert.equal(st.node.kind, "folder");
  assert.deepEqual(st.node.createdBy, USER);
});

test("VFS-02 move a folder into its own child → E_CYCLE, tree unchanged", async () => {
  const { k, storage } = setup();
  await k.vfs.create(u, "/Documents/A", "folder");
  await k.vfs.create(u, "/Documents/A/B", "folder");
  const before = JSON.stringify(storage.state);
  assert.equal(await code(k.vfs.move(u, "/Documents/A", "/Documents/A/B")), "E_CYCLE");
  assert.equal(await code(k.vfs.move(u, "/Documents/A", "/Documents/A")), "E_CYCLE");
  assert.equal(await code(k.vfs.copy(u, "/Documents/A", "/Documents/A/B")), "E_CYCLE");
  assert.equal(JSON.stringify(storage.state), before);
});

test("VFS-03 trash then restore returns to original path", async () => {
  const { k } = setup();
  const t = await k.vfs.trash(u, "/Documents/Welcome.txt");
  assert.equal(t.path, "/Trash/Welcome.txt");
  assert.equal(k.vfs.exists(u, "/Documents/Welcome.txt"), false);
  const r = await k.vfs.restore(u, "/Trash/Welcome.txt");
  assert.equal(r.path, "/Documents/Welcome.txt");
  assert.equal(r.node.trashedFrom, undefined);
});

test("VFS-03b restore recreates missing parent folders", async () => {
  const { k } = setup();
  await k.vfs.create(u, "/Documents/Deep", "folder");
  await k.vfs.create(u, "/Documents/Deep/n.txt", "file", { content: "x" });
  await k.vfs.trash(u, "/Documents/Deep/n.txt");
  await k.vfs.trash(u, "/Documents/Deep");
  await k.vfs.emptyTrash(u); // removes Deep, keeps nothing
  assert.equal(k.vfs.list(u, "/Trash").length, 0);
  await k.vfs.create(u, "/Documents/Deep2", "folder");
  await k.vfs.create(u, "/Documents/Deep2/m.txt", "file");
  await k.vfs.trash(u, "/Documents/Deep2/m.txt");
  await k.vfs.trash(u, "/Documents/Deep2");
  await k.vfs.restore(u, "/Trash/m.txt");
  assert.equal(k.vfs.exists(u, "/Documents/Deep2/m.txt"), true);
});

test("VFS-04 export → reset → import(replace) deep-equals, ids/revs/provenance preserved", async () => {
  const { k } = setup({ consent: "granted" });
  await k.vfs.create(sage, "/Shared/notes.txt", "file", { content: "hi", origin: { taskId: "t1" } });
  await k.vfs.write(sage, "/Shared/notes.txt", "hi again", { ifRev: 1 });
  const bundle = k.vfs.exportBundle();
  await k.vfs.reset(u);
  assert.equal(k.vfs.exists(u, "/Shared/notes.txt"), false);
  await k.vfs.importBundle(u, bundle, "replace");
  const after = k.vfs.exportBundle();
  const byId = (b: typeof bundle) => Object.fromEntries(b.nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId(after), byId(bundle));
  const st = k.vfs.stat(u, "/Shared/notes.txt").node;
  assert.equal(st.rev, 2);
  assert.deepEqual(st.createdBy, agent("sage"));
  assert.deepEqual(st.origin, { taskId: "t1" });
});

test("VFS-04b import merge skips collisions and adds new nodes", async () => {
  const a = setup();
  await a.k.vfs.create(u, "/Documents/only-in-a.txt", "file", { content: "a" });
  const bundle = a.k.vfs.exportBundle();
  const b = setup({ newId: (() => { let i = 0; return () => `b${++i}`; })() });
  await b.k.vfs.write(u, "/Documents/Welcome.txt", "mine");
  await b.k.vfs.importBundle(u, bundle, "merge");
  assert.equal(b.k.vfs.read(u, "/Documents/Welcome.txt").content, "mine");
  assert.equal(b.k.vfs.read(u, "/Documents/only-in-a.txt").content, "a");
});

test("VFS-05 copy into own folder → 'name 2'", async () => {
  const { k } = setup();
  const c1 = await k.vfs.copy(u, "/Documents/Welcome.txt", "/Documents");
  const c2 = await k.vfs.copy(u, "/Documents/Welcome.txt", "/Documents");
  assert.equal(c1.path, "/Documents/Welcome 2.txt");
  assert.equal(c2.path, "/Documents/Welcome 3.txt");
  assert.equal(numberedName("folder", 2), "folder 2");
});

test("VFS-06 storage failure → E_QUOTA, tree unchanged, no event", async () => {
  const { k, storage, events } = setup();
  const before = JSON.stringify(storage.state);
  const n = events.length;
  storage.failNextSave = true;
  assert.equal(await code(k.vfs.write(u, "/Documents/Welcome.txt", "boom")), "E_QUOTA");
  assert.equal(JSON.stringify(storage.state), before);
  assert.equal(k.vfs.read(u, "/Documents/Welcome.txt").rev, 1);
  assert.equal(events.length, n);
});

test("VFS-07 agent write outside home+/Shared, consent denied → E_CONSENT, tree unchanged, consent:requested", async () => {
  const { k, storage, events, asked } = setup({ consent: "denied" });
  const before = JSON.stringify(storage.state);
  assert.equal(await code(k.vfs.write(sage, "/Documents/Welcome.txt", "x", { ifRev: 1 })), "E_CONSENT");
  assert.equal(await code(k.vfs.create(sage, "/Documents/new.txt", "file")), "E_CONSENT");
  assert.equal(JSON.stringify(storage.state), before);
  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.actor.id, "sage");
  assert.equal(asked[0]!.action, "vfs.write");
  assert.ok(events.some((e) => e.type === "consent:requested"));
  assert.ok(events.some((e) => e.type === "consent:resolved" && e.decision === "denied"));
});

test("VFS-07b agent writes freely in its home (auto-created) and /Shared; granted consent allows outside", async () => {
  const { k, asked } = setup({ consent: "granted" });
  const h = await k.vfs.create(sage, "/Familiars/sage/scratch.txt", "file", { content: "s" });
  assert.equal(h.path, "/Familiars/sage/scratch.txt");
  assert.deepEqual(k.vfs.stat(u, "/Familiars/sage").node.createdBy, SYSTEM);
  await k.vfs.create(sage, "/Shared/s.txt", "file");
  assert.equal(asked.length, 0);
  await k.vfs.write(sage, "/Documents/Welcome.txt", "edited by sage", { ifRev: 1 });
  assert.equal(asked.length, 1);
  assert.deepEqual(k.vfs.stat(u, "/Documents/Welcome.txt").node.modifiedBy, agent("sage"));
});

test("VFS-07c another familiar's home is outside the zone", async () => {
  const { k, asked } = setup({ consent: "denied" });
  await k.vfs.create({ actor: agent("cody") }, "/Familiars/cody/x.txt", "file");
  assert.equal(await code(k.vfs.create(sage, "/Familiars/cody/y.txt", "file")), "E_CONSENT");
  assert.equal(asked.length, 1);
});

test("VFS-07d agents always ask to empty Trash and to restore what they did not trash", async () => {
  const { k, asked } = setup({ consent: "denied" });
  await k.vfs.trash(u, "/Documents/Welcome.txt");
  assert.equal(await code(k.vfs.restore(sage, "/Trash/Welcome.txt")), "E_CONSENT");
  assert.equal(await code(k.vfs.emptyTrash(sage)), "E_CONSENT");
  assert.equal(asked.length, 2);
});

test("VFS-08 stale ifRev → E_CONFLICT, first write intact, rev advanced once", async () => {
  const { k } = setup({ consent: "granted" });
  await k.vfs.create(sage, "/Shared/doc.txt", "file", { content: "v1" });
  const echo = { actor: agent("echo") };
  const [a, b] = await Promise.all([
    code(k.vfs.write(sage, "/Shared/doc.txt", "from sage", { ifRev: 1 })),
    code(k.vfs.write(echo, "/Shared/doc.txt", "from echo", { ifRev: 1 })),
  ]);
  assert.deepEqual([a, b], ["ok", "E_CONFLICT"]);
  const r = k.vfs.read(u, "/Shared/doc.txt");
  assert.equal(r.content, "from sage");
  assert.equal(r.rev, 2);
});

test("readonly and system nodes", async () => {
  const { k } = setup();
  assert.equal(await code(k.vfs.create(u, "/Applications/x.txt", "file")), "E_READONLY");
  assert.equal(await code(k.vfs.trash(u, "/Documents/../x")), "E_INVALID_NAME");
  assert.equal(await code(k.vfs.rename(u, "/Trash", "Bin")), "E_READONLY");
  assert.equal(await code(k.vfs.trash(u, "/Shared")), "E_READONLY");
});

test("names: case-insensitive uniqueness, case-only rename allowed", async () => {
  const { k } = setup();
  await k.vfs.create(u, "/Documents/a.txt", "file");
  assert.equal(await code(k.vfs.create(u, "/Documents/A.TXT", "file")), "E_EXISTS");
  const r = await k.vfs.rename(u, "/Documents/a.txt", "A.txt");
  assert.equal(r.path, "/Documents/A.txt");
  assert.equal(await code(k.vfs.rename(u, "/Documents/A.txt", "Welcome.TXT")), "E_EXISTS");
  assert.equal(await code(k.vfs.create(u, "/Documents/ bad", "file")), "E_INVALID_NAME");
  assert.equal(await code(k.vfs.create(u, "/Documents/" + "x".repeat(256), "file")), "E_INVALID_NAME");
});

test("move collisions: user fails by default, agent keeps both", async () => {
  const { k } = setup({ consent: "granted" });
  await k.vfs.create(u, "/Shared/Welcome.txt", "file");
  assert.equal(await code(k.vfs.move(u, "/Documents/Welcome.txt", "/Shared")), "E_EXISTS");
  const kept = await k.vfs.move(sage, "/Documents/Welcome.txt", "/Shared", { ifRev: 1 });
  assert.equal(kept.path, "/Shared/Welcome 2.txt");
});

test("vfs:changed carries actor and causeId", async () => {
  const { k, events } = setup();
  await k.vfs.create({ actor: USER, causeId: "cmd-9" }, "/Documents/x.txt", "file");
  const e = events.findLast((e) => e.type === "vfs:changed")!;
  assert.deepEqual(e.actor, USER);
  assert.equal(e.causeId, "cmd-9");
  assert.deepEqual(e.paths, ["/Documents/x.txt"]);
});

test("a pending consent dialog does not block other writers", async () => {
  let release!: (d: "granted") => void;
  const { k } = setup({ decideConsent: () => new Promise((r) => (release = r)) });
  const pending = k.vfs.write(sage, "/Documents/Welcome.txt", "later", { ifRev: 1 });
  await k.vfs.create(u, "/Documents/quick.txt", "file");
  assert.equal(k.vfs.exists(u, "/Documents/quick.txt"), true);
  release("granted");
  await pending;
  assert.equal(k.vfs.read(u, "/Documents/Welcome.txt").content, "later");
});
