import { createKernel, MemoryStorage, type ConsentDecision, type ConsentRequest, type KernelEvent, type KernelOptions } from "../src/index.ts";

export function setup(opts: KernelOptions & { consent?: ConsentDecision | ((r: ConsentRequest) => ConsentDecision) } = {}) {
  let n = 0;
  let t = 1_000;
  const storage = (opts.storage as MemoryStorage | undefined) ?? new MemoryStorage();
  const asked: ConsentRequest[] = [];
  const decide = async (r: ConsentRequest): Promise<ConsentDecision> => {
    asked.push(r);
    const c = opts.consent ?? "denied";
    return typeof c === "function" ? c(r) : c;
  };
  const k = createKernel({
    newId: () => `id${++n}`,
    now: () => ++t,
    decideConsent: decide,
    ...opts,
    storage,
  });
  const events: KernelEvent[] = [];
  k.bus.subscribe((e) => events.push(e));
  return { k, storage, events, asked };
}

export const TEXTEDIT = {
  id: "textedit",
  name: "TextEdit",
  singleton: false,
  opensTypes: ["text/plain", "text/markdown", ".txt", ".md"],
  defaultWindow: { w: 560, h: 400 },
  minWindow: { w: 320, h: 200 },
};

export const FINDER = {
  id: "finder",
  name: "Finder",
  singleton: true,
  opensTypes: [],
  defaultWindow: { w: 640, h: 420 },
  minWindow: { w: 360, h: 240 },
};
