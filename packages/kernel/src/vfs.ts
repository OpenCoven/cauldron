import type { EventBus } from "./bus.ts";
import type { ConsentBroker } from "./consent.ts";
import { KernelError, SYSTEM, type Actor, type Ctx } from "./types.ts";

export type NodeKind = "file" | "folder";

export interface Origin {
  readonly taskId?: string;
  readonly sessionId?: string;
}

export interface VNode {
  id: string;
  kind: NodeKind;
  name: string;
  parentId: string | null;
  createdAt: number;
  modifiedAt: number;
  createdBy: Actor;
  modifiedBy: Actor;
  origin?: Origin;
  rev: number;
  size: number;
  mime?: string;
  /** P0 keeps content inline; a storage adapter may split large blobs out. */
  content?: string;
  flags: { system: boolean; readonly: boolean };
  trashedFrom?: string;
  trashedBy?: Actor;
}

export interface VfsState {
  version: 2;
  rootId: string;
  nodes: Record<string, VNode>;
}

export interface StorageAdapter {
  load(): VfsState | null;
  /** Must throw on failure; a thrown error aborts the mutation with E_QUOTA. */
  save(state: VfsState): void;
}

export class MemoryStorage implements StorageAdapter {
  state: VfsState | null = null;
  failNextSave = false;
  load(): VfsState | null {
    return this.state ? structuredClone(this.state) : null;
  }
  save(state: VfsState): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("QuotaExceededError");
    }
    this.state = structuredClone(state);
  }
}

export interface ExportBundle {
  version: 2;
  exportedAt: number;
  nodes: VNode[];
  blobs: Record<string, string>;
}

export type CollisionPolicy = "keepBoth" | "replace" | "fail";

export interface Stat {
  readonly path: string;
  readonly node: Readonly<VNode>;
}

const MAX_NAME = 255;
const lower = (s: string) => s.toLowerCase();

export function splitPath(path: string): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) throw new KernelError("E_INVALID_ARGS", `not an absolute path: ${path}`);
  const parts = path.split("/").filter((p) => p.length > 0);
  for (const part of parts) validateName(part);
  return parts;
}

export function validateName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > MAX_NAME ||
    name.includes("/") ||
    name !== name.trim() ||
    name === "." ||
    name === ".."
  ) {
    throw new KernelError("E_INVALID_NAME", JSON.stringify(name));
  }
}

const joinPath = (parent: string, name: string) => (parent === "/" ? `/${name}` : `${parent}/${name}`);
const parentOf = (path: string) => {
  const parts = splitPath(path);
  return "/" + parts.slice(0, -1).join("/");
};
const baseOf = (path: string) => {
  const parts = splitPath(path);
  if (parts.length === 0) throw new KernelError("E_INVALID_ARGS", "root has no name");
  return parts[parts.length - 1]!;
};

/** "notes.txt" → "notes 2.txt"; "folder" → "folder 2". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
  return `${name} ${n}`;
}

export interface VfsOptions {
  bus: EventBus;
  consent: ConsentBroker;
  storage: StorageAdapter;
  now: () => number;
  newId: () => string;
  appIds?: () => string[];
}

/**
 * Actor-aware virtual filesystem. Every mutation:
 * 1. resolves consent (outside the write lock, so a pending dialog never blocks others),
 * 2. runs inside a serialized transaction on a cloned draft,
 * 3. persists the draft (failure → E_QUOTA, tree unchanged),
 * 4. emits `vfs:changed` with actor and causeId.
 */
export class Vfs {
  #state: VfsState;
  #opts: VfsOptions;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(opts: VfsOptions) {
    this.#opts = opts;
    const loaded = opts.storage.load();
    this.#state = loaded ?? this.#firstBoot();
    if (!loaded) opts.storage.save(this.#state);
  }

  // ---------- reads ----------

  stat(_ctx: Ctx, path: string): Stat {
    const node = this.#resolve(this.#state, path);
    if (!node) throw new KernelError("E_NOTFOUND", path);
    return { path: this.#pathOf(this.#state, node), node: structuredClone(node) };
  }

  exists(_ctx: Ctx, path: string): boolean {
    return this.#resolve(this.#state, path) !== undefined;
  }

  list(_ctx: Ctx, path: string): Stat[] {
    const folder = this.#mustFolder(this.#state, path);
    return this.#children(this.#state, folder.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ path: this.#pathOf(this.#state, n), node: structuredClone(n) }));
  }

  read(_ctx: Ctx, path: string): { content: string; rev: number } {
    const node = this.#resolve(this.#state, path);
    if (!node) throw new KernelError("E_NOTFOUND", path);
    if (node.kind !== "file") throw new KernelError("E_INVALID_ARGS", `${path} is a folder`);
    return { content: node.content ?? "", rev: node.rev };
  }

  // ---------- mutations ----------

  async create(
    ctx: Ctx,
    path: string,
    kind: NodeKind,
    opts: { content?: string; mime?: string; origin?: Origin } = {},
  ): Promise<Stat> {
    const name = baseOf(path);
    const parentPath = parentOf(path);
    await this.#gate(ctx, "vfs.create", [path]);
    return this.#tx(ctx, [path], (s) => {
      this.#ensureHome(s, ctx, parentPath);
      const parent = this.#mustFolder(s, parentPath);
      if (parent.flags.readonly) throw new KernelError("E_READONLY", parentPath);
      if (this.#childNamed(s, parent.id, name)) throw new KernelError("E_EXISTS", path);
      const node = this.#newNode(s, ctx, kind, name, parent.id, opts);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async write(ctx: Ctx, path: string, content: string, opts: { ifRev?: number; origin?: Origin } = {}): Promise<Stat> {
    if (typeof content !== "string") throw new KernelError("E_INVALID_ARGS", "content must be a string");
    this.#requireRev(ctx, opts.ifRev);
    await this.#gate(ctx, "vfs.write", [path]);
    return this.#tx(ctx, [path], (s) => {
      const node = this.#mustMutable(s, path, opts.ifRev);
      if (node.kind !== "file") throw new KernelError("E_INVALID_ARGS", `${path} is a folder`);
      node.content = content;
      node.size = byteLength(content);
      if (opts.origin) node.origin = opts.origin;
      this.#touch(node, ctx);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async rename(ctx: Ctx, path: string, newName: string, opts: { ifRev?: number } = {}): Promise<Stat> {
    validateName(newName);
    this.#requireRev(ctx, opts.ifRev);
    const target = joinPath(parentOf(path), newName);
    await this.#gate(ctx, "vfs.rename", [path, target]);
    return this.#tx(ctx, [path, target], (s) => {
      const node = this.#mustMutable(s, path, opts.ifRev);
      const clash = this.#childNamed(s, node.parentId!, newName);
      if (clash && clash.id !== node.id) throw new KernelError("E_EXISTS", target);
      node.name = newName;
      this.#touch(node, ctx);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async move(
    ctx: Ctx,
    path: string,
    destFolder: string,
    opts: { ifRev?: number; onCollision?: CollisionPolicy } = {},
  ): Promise<Stat> {
    this.#requireRev(ctx, opts.ifRev);
    const policy = opts.onCollision ?? (ctx.actor.kind === "agent" ? "keepBoth" : "fail");
    await this.#gate(ctx, "vfs.move", [path, joinPath(destFolder, baseOf(path))]);
    return this.#tx(ctx, [path, destFolder], (s) => {
      const node = this.#mustMutable(s, path, opts.ifRev);
      const dest = this.#mustFolder(s, destFolder);
      if (dest.flags.readonly) throw new KernelError("E_READONLY", destFolder);
      if (this.#isSelfOrDescendant(s, dest.id, node.id)) throw new KernelError("E_CYCLE", `${path} → ${destFolder}`);
      if (dest.id === node.parentId) return { path: this.#pathOf(s, node), node: structuredClone(node) };
      node.name = this.#placeName(s, dest.id, node.name, policy, ctx);
      node.parentId = dest.id;
      this.#touch(node, ctx);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async copy(ctx: Ctx, path: string, destFolder: string): Promise<Stat> {
    await this.#gate(ctx, "vfs.copy", [joinPath(destFolder, baseOf(path))]);
    return this.#tx(ctx, [destFolder], (s) => {
      const source = this.#resolve(s, path);
      if (!source) throw new KernelError("E_NOTFOUND", path);
      const dest = this.#mustFolder(s, destFolder);
      if (dest.flags.readonly) throw new KernelError("E_READONLY", destFolder);
      if (this.#isSelfOrDescendant(s, dest.id, source.id)) throw new KernelError("E_CYCLE", `${path} → ${destFolder}`);
      const name = this.#placeName(s, dest.id, source.name, "keepBoth", ctx);
      const copyTree = (src: VNode, parentId: string, as: string): VNode => {
        const copy = this.#newNode(s, ctx, src.kind, as, parentId, {
          content: src.content,
          mime: src.mime,
          origin: src.origin,
        });
        for (const child of this.#children(s, src.id)) copyTree(child, copy.id, child.name);
        return copy;
      };
      const root = copyTree(source, dest.id, name);
      return { path: this.#pathOf(s, root), node: structuredClone(root) };
    });
  }

  async trash(ctx: Ctx, path: string, opts: { ifRev?: number } = {}): Promise<Stat> {
    this.#requireRev(ctx, opts.ifRev);
    await this.#gate(ctx, "vfs.trash", [path]);
    return this.#tx(ctx, [path, "/Trash"], (s) => {
      const node = this.#mustMutable(s, path, opts.ifRev);
      const trash = this.#mustFolder(s, "/Trash");
      if (this.#isSelfOrDescendant(s, node.id, trash.id) || node.parentId === trash.id) {
        throw new KernelError("E_INVALID_ARGS", `${path} is already in the Trash`);
      }
      node.trashedFrom = this.#pathOf(s, node);
      node.trashedBy = ctx.actor;
      node.name = this.#placeName(s, trash.id, node.name, "keepBoth", ctx);
      node.parentId = trash.id;
      this.#touch(node, ctx);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async restore(ctx: Ctx, trashPath: string): Promise<Stat> {
    const pre = this.#resolve(this.#state, trashPath);
    if (!pre?.trashedFrom) throw new KernelError("E_NOTFOUND", `${trashPath} is not in the Trash`);
    const ownTrash = pre.trashedBy?.kind === ctx.actor.kind && pre.trashedBy?.id === ctx.actor.id;
    await this.#gate(ctx, "vfs.restore", [pre.trashedFrom], ctx.actor.kind === "agent" && !ownTrash);
    return this.#tx(ctx, [trashPath, pre.trashedFrom], (s) => {
      const node = this.#resolve(s, trashPath);
      if (!node?.trashedFrom) throw new KernelError("E_NOTFOUND", trashPath);
      const originalName = baseOf(node.trashedFrom);
      const parent = this.#mkdirp(s, ctx, parentOf(node.trashedFrom));
      node.name = this.#placeName(s, parent.id, originalName, "keepBoth", ctx);
      node.parentId = parent.id;
      delete node.trashedFrom;
      delete node.trashedBy;
      this.#touch(node, ctx);
      return { path: this.#pathOf(s, node), node: structuredClone(node) };
    });
  }

  async emptyTrash(ctx: Ctx): Promise<number> {
    await this.#gate(ctx, "vfs.emptyTrash", ["/Trash"], ctx.actor.kind === "agent");
    return this.#tx(ctx, ["/Trash"], (s) => {
      const trash = this.#mustFolder(s, "/Trash");
      let removed = 0;
      const drop = (id: string) => {
        for (const child of this.#children(s, id)) drop(child.id);
        delete s.nodes[id];
        removed++;
      };
      for (const child of this.#children(s, trash.id)) drop(child.id);
      return removed;
    });
  }

  // ---------- backup / restore ----------

  exportBundle(): ExportBundle {
    return {
      version: 2,
      exportedAt: this.#opts.now(),
      nodes: Object.values(structuredClone(this.#state.nodes)),
      blobs: {},
    };
  }

  async importBundle(ctx: Ctx, bundle: ExportBundle, mode: "replace" | "merge"): Promise<void> {
    if (ctx.actor.kind !== "user") throw new KernelError("E_CONSENT", "only the user may import");
    if (!bundle || bundle.version !== 2 || !Array.isArray(bundle.nodes)) {
      throw new KernelError("E_INVALID_ARGS", "unsupported export version");
    }
    const root = bundle.nodes.find((n) => n.parentId === null);
    if (!root) throw new KernelError("E_INVALID_ARGS", "bundle has no root");
    await this.#tx(ctx, ["/"], (s) => {
      if (mode === "replace") {
        s.rootId = root.id;
        s.nodes = Object.fromEntries(bundle.nodes.map((n) => [n.id, structuredClone(n)]));
        return;
      }
      // merge: map bundle folders onto existing paths; skip colliding files
      const incoming = new Map(bundle.nodes.map((n) => [n.id, n]));
      const pathIn = (n: VNode): string => {
        const names: string[] = [];
        let cur: VNode | undefined = n;
        while (cur && cur.parentId !== null) {
          names.unshift(cur.name);
          cur = incoming.get(cur.parentId);
        }
        return "/" + names.join("/");
      };
      const ordered = [...bundle.nodes].filter((n) => n.parentId !== null).sort((a, b) => pathIn(a).length - pathIn(b).length);
      for (const n of ordered) {
        const p = pathIn(n);
        if (this.#resolve(s, p)) continue;
        const parent = this.#resolve(s, parentOf(p));
        if (!parent || parent.kind !== "folder") continue;
        s.nodes[n.id] = { ...structuredClone(n), parentId: parent.id };
      }
    });
  }

  async reset(ctx: Ctx): Promise<void> {
    if (ctx.actor.kind !== "user") throw new KernelError("E_CONSENT", "only the user may reset");
    await this.#tx(ctx, ["/"], (s) => {
      const fresh = this.#firstBoot();
      s.rootId = fresh.rootId;
      s.nodes = fresh.nodes;
    });
  }

  // ---------- internals ----------

  /** Agents may act freely in their home and /Shared; anything else asks the human. */
  async #gate(ctx: Ctx, action: string, targets: string[], force = false): Promise<void> {
    if (ctx.actor.kind !== "agent") return;
    const outside = force ? targets : targets.filter((t) => !inAgentZone(ctx.actor.id, t));
    if (outside.length === 0) return;
    const decision = await this.#opts.consent.request(
      { actor: ctx.actor, action, target: outside.join(", ") },
      ctx.causeId,
    );
    if (decision !== "granted") throw new KernelError("E_CONSENT", `${action} ${outside.join(", ")}`);
  }

  #requireRev(ctx: Ctx, ifRev: number | undefined): void {
    if (ifRev !== undefined && !Number.isInteger(ifRev)) throw new KernelError("E_INVALID_ARGS", "ifRev must be an integer");
    if (ctx.actor.kind === "agent" && ifRev === undefined) {
      throw new KernelError("E_INVALID_ARGS", "agent mutations must supply ifRev");
    }
  }

  #tx<T>(ctx: Ctx, paths: string[], mutate: (draft: VfsState) => T): Promise<T> {
    const run = () => {
      const draft = structuredClone(this.#state);
      const value = mutate(draft);
      try {
        this.#opts.storage.save(draft);
      } catch (err) {
        throw new KernelError("E_QUOTA", String((err as Error)?.message ?? err));
      }
      this.#state = draft;
      this.#opts.bus.emit({ type: "vfs:changed", actor: ctx.actor, causeId: ctx.causeId, paths });
      return value;
    };
    const next = this.#lock.then(run, run);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  #firstBoot(): VfsState {
    const now = this.#opts.now();
    const nodes: Record<string, VNode> = {};
    const mk = (name: string, parentId: string | null, flags: VNode["flags"], kind: NodeKind = "folder", content?: string) => {
      const id = this.#opts.newId();
      nodes[id] = {
        id,
        kind,
        name,
        parentId,
        createdAt: now,
        modifiedAt: now,
        createdBy: SYSTEM,
        modifiedBy: SYSTEM,
        rev: 1,
        size: content ? byteLength(content) : 0,
        ...(content !== undefined ? { content, mime: "text/plain" } : {}),
        flags,
      };
      return id;
    };
    const sys = { system: true, readonly: false };
    const root = mk("", null, sys);
    mk("Applications", root, { system: true, readonly: true });
    const docs = mk("Documents", root, { system: false, readonly: false });
    mk("Welcome.txt", docs, { system: false, readonly: false }, "file", WELCOME);
    mk("Desktop", root, sys);
    mk("Familiars", root, sys);
    mk("Shared", root, sys);
    mk("Trash", root, sys);
    return { version: 2, rootId: root, nodes };
  }

  #newNode(s: VfsState, ctx: Ctx, kind: NodeKind, name: string, parentId: string, opts: { content?: string; mime?: string; origin?: Origin }): VNode {
    const now = this.#opts.now();
    const content = kind === "file" ? (opts.content ?? "") : undefined;
    const node: VNode = {
      id: this.#opts.newId(),
      kind,
      name,
      parentId,
      createdAt: now,
      modifiedAt: now,
      createdBy: ctx.actor,
      modifiedBy: ctx.actor,
      rev: 1,
      size: content ? byteLength(content) : 0,
      flags: { system: false, readonly: false },
    };
    if (content !== undefined) node.content = content;
    if (opts.mime) node.mime = opts.mime;
    if (opts.origin) node.origin = opts.origin;
    s.nodes[node.id] = node;
    return node;
  }

  #touch(node: VNode, ctx: Ctx): void {
    node.rev += 1;
    node.modifiedAt = this.#opts.now();
    node.modifiedBy = ctx.actor;
  }

  #children(s: VfsState, parentId: string): VNode[] {
    return Object.values(s.nodes).filter((n) => n.parentId === parentId);
  }

  #childNamed(s: VfsState, parentId: string, name: string): VNode | undefined {
    const key = lower(name);
    return this.#children(s, parentId).find((n) => lower(n.name) === key);
  }

  #resolve(s: VfsState, path: string): VNode | undefined {
    let node: VNode | undefined = s.nodes[s.rootId];
    for (const part of splitPath(path)) {
      if (!node || node.kind !== "folder") return undefined;
      node = this.#childNamed(s, node.id, part);
    }
    return node;
  }

  #pathOf(s: VfsState, node: VNode): string {
    const names: string[] = [];
    let cur: VNode | undefined = node;
    while (cur && cur.parentId !== null) {
      names.unshift(cur.name);
      cur = s.nodes[cur.parentId];
    }
    return "/" + names.join("/");
  }

  #mustFolder(s: VfsState, path: string): VNode {
    const node = this.#resolve(s, path);
    if (!node) throw new KernelError("E_NOTFOUND", path);
    if (node.kind !== "folder") throw new KernelError("E_INVALID_ARGS", `${path} is not a folder`);
    return node;
  }

  #mustMutable(s: VfsState, path: string, ifRev: number | undefined): VNode {
    const node = this.#resolve(s, path);
    if (!node) throw new KernelError("E_NOTFOUND", path);
    if (node.flags.system || node.flags.readonly) throw new KernelError("E_READONLY", path);
    const parent = node.parentId ? s.nodes[node.parentId] : undefined;
    if (parent?.flags.readonly) throw new KernelError("E_READONLY", path);
    if (ifRev !== undefined && ifRev !== node.rev) throw new KernelError("E_CONFLICT", `${path} is at rev ${node.rev}, not ${ifRev}`);
    return node;
  }

  #isSelfOrDescendant(s: VfsState, candidateId: string, ancestorId: string): boolean {
    let cur: VNode | undefined = s.nodes[candidateId];
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? s.nodes[cur.parentId] : undefined;
    }
    return false;
  }

  #placeName(s: VfsState, parentId: string, name: string, policy: CollisionPolicy, ctx: Ctx): string {
    const clash = this.#childNamed(s, parentId, name);
    if (!clash) return name;
    if (policy === "fail") throw new KernelError("E_EXISTS", name);
    if (policy === "replace") {
      if (clash.flags.system || clash.flags.readonly) throw new KernelError("E_READONLY", clash.name);
      const drop = (id: string) => {
        for (const c of this.#children(s, id)) drop(c.id);
        delete s.nodes[id];
      };
      drop(clash.id);
      return name;
    }
    for (let n = 2; ; n++) {
      const candidate = numberedName(name, n);
      if (!this.#childNamed(s, parentId, candidate)) return candidate;
    }
  }

  #mkdirp(s: VfsState, ctx: Ctx, path: string): VNode {
    let node = s.nodes[s.rootId]!;
    for (const part of splitPath(path)) {
      const next = this.#childNamed(s, node.id, part);
      if (next) {
        if (next.kind !== "folder") throw new KernelError("E_EXISTS", part);
        node = next;
      } else {
        node = this.#newNode(s, ctx, "folder", part, node.id, {});
      }
    }
    return node;
  }

  /** An agent's home is created on its first write there. */
  #ensureHome(s: VfsState, ctx: Ctx, parentPath: string): void {
    if (ctx.actor.kind !== "agent") return;
    const home = `/Familiars/${ctx.actor.id}`;
    const p = lower(parentPath);
    if (p !== lower(home) && !p.startsWith(lower(home) + "/")) return;
    const familiars = this.#mustFolder(s, "/Familiars");
    if (!this.#childNamed(s, familiars.id, ctx.actor.id)) {
      this.#newNode(s, { actor: SYSTEM }, "folder", ctx.actor.id, familiars.id, {});
    }
  }
}

export function inAgentZone(agentId: string, path: string): boolean {
  const p = lower(path);
  const home = lower(`/Familiars/${agentId}/`);
  return p.startsWith("/shared/") || p.startsWith(home);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const WELCOME = `Welcome.

This desktop is shared. Windows and files show who made them —
you, or one of your familiars. Get Info on any file tells you who
wrote it and when. When a familiar wants to act outside its own
folder, it asks you first.
`;
