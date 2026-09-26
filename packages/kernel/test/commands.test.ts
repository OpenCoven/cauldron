import { test } from "node:test";
import assert from "node:assert/strict";
import { USER, agent } from "../src/index.ts";
import { setup } from "./helpers.ts";

const sage = agent("sage");

test("CMD-01 replaying an idempotencyKey returns the original result without re-executing", async () => {
  const { k, events } = setup();
  const cmd = { id: "c1", actor: sage, op: "vfs.create", args: { path: "/Shared/once.txt", kind: "file", content: "1" }, idempotencyKey: "k1" };
  const first = await k.commands.execute(cmd);
  const changes = events.filter((e) => e.type === "vfs:changed").length;
  const again = await k.commands.execute({ ...cmd, id: "c2" });
  assert.equal(first.ok, true);
  assert.deepEqual(again, first);
  assert.equal(events.filter((e) => e.type === "vfs:changed").length, changes);
  // key is scoped per actor
  const other = await k.commands.execute({ ...cmd, id: "c3", actor: agent("echo") });
  assert.deepEqual(other, { ok: false, error: "E_EXISTS", detail: "/Shared/once.txt" });
});

test("CMD-02 unknown op → E_UNKNOWN_OP", async () => {
  const { k } = setup();
  const r = await k.commands.execute({ id: "c1", actor: USER, op: "vfs.teleport" });
  assert.deepEqual(r, { ok: false, error: "E_UNKNOWN_OP", detail: "vfs.teleport" });
});

test("CMD-03 agent mutation without ifRev → E_INVALID_ARGS, tree unchanged", async () => {
  const { k, storage } = setup();
  await k.commands.execute({ id: "c0", actor: sage, op: "vfs.create", args: { path: "/Shared/a.txt", kind: "file" } });
  const before = JSON.stringify(storage.state);
  const r = await k.commands.execute({ id: "c1", actor: sage, op: "vfs.write", args: { path: "/Shared/a.txt", content: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "E_INVALID_ARGS");
  assert.equal(JSON.stringify(storage.state), before);
});

test("causeId on events is the command id", async () => {
  const { k, events } = setup();
  await k.commands.execute({ id: "cmd-42", actor: USER, op: "vfs.create", args: { path: "/Documents/n.txt", kind: "file" } });
  const e = events.findLast((e) => e.type === "vfs:changed")!;
  assert.equal(e.causeId, "cmd-42");
});

test("malformed command and bad args", async () => {
  const { k } = setup();
  // @ts-expect-error deliberately malformed
  assert.equal((await k.commands.execute({ op: "vfs.read" })).ok, false);
  const r = await k.commands.execute({ id: "x", actor: USER, op: "vfs.read", args: { path: 7 } });
  assert.equal(r.ok === false && r.error, "E_INVALID_ARGS");
});

test("the agent API surface", () => {
  const { k } = setup();
  assert.deepEqual(k.commands.ops(), [
    "vfs.copy", "vfs.create", "vfs.emptyTrash", "vfs.exists", "vfs.list", "vfs.move", "vfs.read",
    "vfs.rename", "vfs.restore", "vfs.stat", "vfs.trash", "vfs.write",
    "wm.close", "wm.focus", "wm.open", "wm.setStatus",
  ]);
});
