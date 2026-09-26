import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsentBroker, EventBus, USER, SYSTEM, agent, createKernel, type ConsentRequest } from "../src/index.ts";

test("consent is FIFO: the decider never sees two requests at once", async () => {
  const bus = new EventBus();
  let open = 0;
  let maxOpen = 0;
  const seen: string[] = [];
  let i = 0;
  const broker = new ConsentBroker(
    bus,
    async (r: ConsentRequest) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      seen.push(r.target);
      await new Promise((res) => setTimeout(res, 5));
      open--;
      return r.target === "b" ? "denied" : "granted";
    },
    () => `r${++i}`,
  );
  const results = await Promise.all(["a", "b", "c"].map((t) => broker.request({ actor: agent("sage"), action: "x", target: t })));
  assert.deepEqual(results, ["granted", "denied", "granted"]);
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(maxOpen, 1);
  assert.equal(broker.pending, 0);
});

test("users and system are never asked; a throwing decider denies", async () => {
  const bus = new EventBus();
  let asked = 0;
  const broker = new ConsentBroker(bus, async () => { asked++; throw new Error("dialog crashed"); }, () => "r");
  assert.equal(await broker.request({ actor: USER, action: "x", target: "t" }), "granted");
  assert.equal(await broker.request({ actor: SYSTEM, action: "x", target: "t" }), "granted");
  assert.equal(await broker.request({ actor: agent("a"), action: "x", target: "t" }), "denied");
  assert.equal(asked, 1);
});

test("without a host decider the kernel fails closed", async () => {
  const k = createKernel();
  await assert.rejects(k.vfs.write({ actor: agent("sage") }, "/Documents/Welcome.txt", "x", { ifRev: 1 }), /E_CONSENT/);
});
