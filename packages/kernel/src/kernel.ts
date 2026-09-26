import { EventBus } from "./bus.ts";
import { CommandBus } from "./commands.ts";
import { ConsentBroker, denyAll, type ConsentDecider } from "./consent.ts";
import { AppRegistry } from "./registry.ts";
import { KernelError } from "./types.ts";
import { MemoryStorage, Vfs, type CollisionPolicy, type NodeKind, type Origin, type StorageAdapter } from "./vfs.ts";
import { WindowManager, type Size, type WindowStatus, type WmMetrics } from "./wm.ts";

export interface KernelOptions {
  storage?: StorageAdapter;
  /** Host-supplied consent UI. Without one, every agent request outside its zone is denied. */
  decideConsent?: ConsentDecider;
  viewport?: Size;
  metrics?: Partial<WmMetrics>;
  now?: () => number;
  newId?: () => string;
}

export interface Kernel {
  bus: EventBus;
  consent: ConsentBroker;
  vfs: Vfs;
  wm: WindowManager;
  apps: AppRegistry;
  commands: CommandBus;
}

export function createKernel(opts: KernelOptions = {}): Kernel {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const bus = new EventBus();
  const consent = new ConsentBroker(bus, opts.decideConsent ?? denyAll, newId);
  const apps = new AppRegistry();
  const vfs = new Vfs({ bus, consent, storage: opts.storage ?? new MemoryStorage(), now, newId, appIds: () => apps.ids() });
  const wm = new WindowManager(bus, opts.viewport ?? { w: 1280, h: 800 }, newId, opts.metrics);
  const commands = new CommandBus();

  const str = (a: Record<string, unknown>, k: string): string => {
    const v = a[k];
    if (typeof v !== "string") throw new KernelError("E_INVALID_ARGS", `${k} must be a string`);
    return v;
  };
  const optInt = (a: Record<string, unknown>, k: string): number | undefined => {
    const v = a[k];
    if (v === undefined) return undefined;
    if (!Number.isInteger(v)) throw new KernelError("E_INVALID_ARGS", `${k} must be an integer`);
    return v as number;
  };
  const origin = (a: Record<string, unknown>) => a.origin as Origin | undefined;

  commands.register("vfs.stat", (c, a) => vfs.stat(c, str(a, "path")));
  commands.register("vfs.exists", (c, a) => vfs.exists(c, str(a, "path")));
  commands.register("vfs.list", (c, a) => vfs.list(c, str(a, "path")));
  commands.register("vfs.read", (c, a) => vfs.read(c, str(a, "path")));
  commands.register("vfs.create", (c, a) => {
    const kind = a.kind === "folder" ? "folder" : a.kind === "file" ? "file" : undefined;
    if (!kind) throw new KernelError("E_INVALID_ARGS", "kind must be file or folder");
    return vfs.create(c, str(a, "path"), kind as NodeKind, {
      content: a.content as string | undefined,
      mime: a.mime as string | undefined,
      origin: origin(a),
    });
  });
  commands.register("vfs.write", (c, a) =>
    vfs.write(c, str(a, "path"), str(a, "content"), { ifRev: optInt(a, "ifRev"), origin: origin(a) }),
  );
  commands.register("vfs.rename", (c, a) => vfs.rename(c, str(a, "path"), str(a, "name"), { ifRev: optInt(a, "ifRev") }));
  commands.register("vfs.move", (c, a) =>
    vfs.move(c, str(a, "path"), str(a, "dest"), {
      ifRev: optInt(a, "ifRev"),
      onCollision: a.onCollision as CollisionPolicy | undefined,
    }),
  );
  commands.register("vfs.copy", (c, a) => vfs.copy(c, str(a, "path"), str(a, "dest")));
  commands.register("vfs.trash", (c, a) => vfs.trash(c, str(a, "path"), { ifRev: optInt(a, "ifRev") }));
  commands.register("vfs.restore", (c, a) => vfs.restore(c, str(a, "path")));
  commands.register("vfs.emptyTrash", (c) => vfs.emptyTrash(c));

  commands.register("wm.open", (c, a) => {
    const app = apps.get(str(a, "appId"));
    return wm.open(c, {
      instanceId: str(a, "instanceId"),
      appId: app.id,
      title: typeof a.title === "string" ? a.title : app.name,
      defaultSize: app.defaultWindow,
      minSize: app.minWindow,
      documentPath: a.documentPath as string | undefined,
      intent: a.intent === "raise" ? "raise" : "request",
    });
  });
  commands.register("wm.focus", (c, a) => wm.focus(c, str(a, "windowId")));
  commands.register("wm.close", (c, a) => wm.close(c, str(a, "windowId")));
  commands.register("wm.setStatus", (c, a) => wm.setStatus(c, str(a, "windowId"), a.status as WindowStatus | undefined));

  return { bus, consent, vfs, wm, apps, commands };
}
