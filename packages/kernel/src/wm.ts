import type { EventBus } from "./bus.ts";
import { KernelError, type Actor, type Ctx } from "./types.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

export type WindowStatus = "idle" | "working" | "waiting-approval";

export interface WindowRecord {
  id: string;
  instanceId: string;
  appId: string;
  ownerActor: Actor;
  title: string;
  rect: Rect;
  userRect?: Rect;
  state: "normal" | "minimized";
  status?: WindowStatus;
  /** Set when an agent opened the window behind the user's focus; cleared on focus. */
  badge: boolean;
  /** Which edge of an agent window was left showing beside the focused window; cleared once the window is moved, resized or zoomed. */
  peek?: "right" | "left" | "top";
  flags: { resizable: boolean; closable: boolean; minimizable: boolean };
  minSize: Size;
  documentPath?: string;
}

export interface OpenOptions {
  instanceId: string;
  appId: string;
  title: string;
  defaultSize: Size;
  minSize: Size;
  documentPath?: string;
  /** Agents may ask to be raised; in P0 the policy still opens them behind. */
  intent?: "request" | "raise";
  flags?: Partial<WindowRecord["flags"]>;
}

export interface WmMetrics {
  menuBarHeight: number;
  titleBarHeight: number;
  cascade: number;
  minVisibleTitle: number;
  /** Width left showing when an agent window opens behind the focused one: room for the familiar's name label. */
  agentPeek: number;
  smallViewport: number;
}

export const DEFAULT_METRICS: WmMetrics = {
  menuBarHeight: 22,
  titleBarHeight: 20,
  cascade: 24,
  minVisibleTitle: 40,
  agentPeek: 120,
  smallViewport: 640,
};

export interface WmSnapshot {
  windows: WindowRecord[];
  /** bottom → top */
  stack: string[];
  focusedId: string | null;
}

export class WindowManager {
  #windows = new Map<string, WindowRecord>();
  /** z-order, bottom → top. The focused window is always the top-most visible one. */
  #stack: string[] = [];
  #focusedId: string | null = null;
  #lastOpenedByApp = new Map<string, string>();
  #viewport: Size;
  #m: WmMetrics;
  #bus: EventBus;
  #newId: () => string;

  constructor(bus: EventBus, viewport: Size, newId: () => string, metrics: Partial<WmMetrics> = {}) {
    this.#bus = bus;
    this.#viewport = { ...viewport };
    this.#newId = newId;
    this.#m = { ...DEFAULT_METRICS, ...metrics };
  }

  get focusedId(): string | null {
    return this.#focusedId;
  }

  get desktopArea(): Rect {
    return { x: 0, y: this.#m.menuBarHeight, w: this.#viewport.w, h: this.#viewport.h - this.#m.menuBarHeight };
  }

  get isSmall(): boolean {
    return this.#viewport.w < this.#m.smallViewport;
  }

  get(id: string): WindowRecord {
    const w = this.#windows.get(id);
    if (!w) throw new KernelError("E_NOTFOUND", `window ${id}`);
    return structuredClone(w);
  }

  /** bottom → top */
  list(): WindowRecord[] {
    return this.#stack.map((id) => structuredClone(this.#windows.get(id)!));
  }

  z(id: string): number {
    return this.#stack.indexOf(id);
  }

  open(ctx: Ctx, opts: OpenOptions): WindowRecord {
    const id = this.#newId();
    const win: WindowRecord = {
      id,
      instanceId: opts.instanceId,
      appId: opts.appId,
      ownerActor: ctx.actor,
      title: opts.title,
      rect: this.#place(opts.appId, opts.defaultSize, opts.minSize),
      state: "normal",
      badge: false,
      flags: { resizable: true, closable: true, minimizable: true, ...opts.flags },
      minSize: { ...opts.minSize },
      ...(opts.documentPath ? { documentPath: opts.documentPath } : {}),
      ...(ctx.actor.kind === "agent" ? { status: "working" as const } : {}),
    };
    this.#windows.set(id, win);
    this.#lastOpenedByApp.set(opts.appId, id);

    const focused = this.#focusedId ? this.#windows.get(this.#focusedId) : undefined;
    const behind = ctx.actor.kind === "agent" && focused && focused.state === "normal";
    if (behind) {
      // Never hidden: an agent window must peek out from behind the focused one.
      const peeked = this.#peek(win.rect, focused.rect);
      if (peeked) [win.rect, win.peek] = [peeked.rect, peeked.side];
      // Never steal focus: slot in directly beneath the focused window and badge it.
      this.#stack.splice(this.#stack.indexOf(focused.id), 0, id);
      win.badge = true;
    } else {
      this.#stack.push(id);
      this.#focusedId = id;
    }
    this.#emit(ctx, "window:opened", id, { behind: Boolean(behind), intent: opts.intent ?? null });
    return structuredClone(win);
  }

  focus(ctx: Ctx, id: string): void {
    const win = this.#must(id);
    if (ctx.actor.kind === "agent" && this.#focusedId !== null && this.#focusedId !== id) {
      // Agents may ask for attention, never take focus.
      win.badge = true;
      this.#emit(ctx, "window:attention", id);
      return;
    }
    win.state = "normal";
    win.badge = false;
    this.#stack = [...this.#stack.filter((x) => x !== id), id];
    this.#focusedId = id;
    this.#emit(ctx, "window:focused", id);
  }

  move(ctx: Ctx, id: string, x: number, y: number): Rect {
    const win = this.#must(id);
    if (this.isSmall) return structuredClone(win.rect);
    const area = this.desktopArea;
    const m = this.#m;
    win.rect.x = clamp(x, m.minVisibleTitle - win.rect.w, area.x + area.w - m.minVisibleTitle);
    win.rect.y = clamp(y, area.y, area.y + area.h - m.titleBarHeight);
    delete win.userRect;
    delete win.peek;
    this.#emit(ctx, "window:moved", id, { rect: win.rect });
    return structuredClone(win.rect);
  }

  resize(ctx: Ctx, id: string, w: number, h: number): Rect {
    const win = this.#must(id);
    if (this.isSmall || !win.flags.resizable) return structuredClone(win.rect);
    win.rect.w = Math.max(w, win.minSize.w);
    win.rect.h = Math.max(h, win.minSize.h);
    delete win.userRect;
    delete win.peek;
    this.#emit(ctx, "window:resized", id, { rect: win.rect });
    return structuredClone(win.rect);
  }

  zoom(ctx: Ctx, id: string): Rect {
    const win = this.#must(id);
    delete win.peek;
    if (win.userRect) {
      win.rect = win.userRect;
      delete win.userRect;
    } else {
      win.userRect = { ...win.rect };
      win.rect = { ...this.desktopArea };
    }
    this.#emit(ctx, "window:zoomed", id, { rect: win.rect });
    return structuredClone(win.rect);
  }

  minimize(ctx: Ctx, id: string): void {
    const win = this.#must(id);
    if (!win.flags.minimizable) return;
    win.state = "minimized";
    if (this.#focusedId === id) this.#refocus();
    this.#emit(ctx, "window:minimized", id);
  }

  close(ctx: Ctx, id: string): void {
    const win = this.#must(id);
    this.#windows.delete(id);
    this.#stack = this.#stack.filter((x) => x !== id);
    if (this.#lastOpenedByApp.get(win.appId) === id) this.#lastOpenedByApp.delete(win.appId);
    if (this.#focusedId === id) this.#refocus();
    this.#emit(ctx, "window:closed", id);
  }

  setStatus(ctx: Ctx, id: string, status: WindowStatus | undefined): void {
    const win = this.#must(id);
    if (status) win.status = status;
    else delete win.status;
    this.#emit(ctx, "window:status", id, { status: status ?? null });
  }

  setTitle(ctx: Ctx, id: string, title: string): void {
    const win = this.#must(id);
    win.title = title;
    this.#emit(ctx, "window:title", id, { title });
  }

  setDocumentPath(ctx: Ctx, id: string, documentPath: string | undefined): void {
    const win = this.#must(id);
    if (documentPath) win.documentPath = documentPath;
    else delete win.documentPath;
    this.#emit(ctx, "window:document", id, { documentPath: documentPath ?? null });
  }

  setViewport(viewport: Size): void {
    this.#viewport = { ...viewport };
  }

  snapshot(): WmSnapshot {
    return { windows: this.list(), stack: [...this.#stack], focusedId: this.#focusedId };
  }

  restore(snap: WmSnapshot): void {
    this.#windows = new Map(snap.windows.map((w) => [w.id, structuredClone(w)]));
    this.#stack = snap.stack.filter((id) => this.#windows.has(id));
    this.#focusedId = snap.focusedId && this.#windows.has(snap.focusedId) ? snap.focusedId : null;
    this.#lastOpenedByApp.clear();
    for (const id of this.#stack) this.#lastOpenedByApp.set(this.#windows.get(id)!.appId, id);
  }

  #place(appId: string, size: Size, min: Size): Rect {
    const area = this.desktopArea;
    if (this.isSmall) return { ...area };
    const w = Math.max(size.w, min.w);
    const h = Math.max(size.h, min.h);
    const centered = { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), w, h };
    const lastId = this.#lastOpenedByApp.get(appId);
    const last = lastId ? this.#windows.get(lastId) : undefined;
    if (!last) return centered;
    const next = { x: last.rect.x + this.#m.cascade, y: last.rect.y + this.#m.cascade, w, h };
    const fits = next.x >= area.x && next.y >= area.y && next.x + w <= area.x + area.w && next.y + h <= area.y + area.h;
    return fits ? next : centered;
  }

  /**
   * Shift `r` so `agentPeek` px of it show beside `over` (right preferred, then left),
   * or its title bar plus `minVisibleTitle` px show above. Returns null when `r` is not covered.
   */
  #peek(r: Rect, over: Rect): { rect: Rect; side: "right" | "left" | "top" } | null {
    const covered = r.x >= over.x && r.y >= over.y && r.x + r.w <= over.x + over.w && r.y + r.h <= over.y + over.h;
    if (!covered || this.isSmall) return null;
    const area = this.desktopArea;
    const peek = Math.min(this.#m.agentPeek, r.w);
    const right = over.x + over.w + peek - r.w;
    if (right + r.w <= area.x + area.w) return { rect: { ...r, x: right }, side: "right" };
    const left = over.x - peek;
    if (left >= area.x) return { rect: { ...r, x: left }, side: "left" };
    const top = Math.max(area.y, over.y - this.#m.titleBarHeight - this.#m.minVisibleTitle);
    return { rect: { ...r, y: top }, side: "top" };
  }

  #refocus(): void {
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      const w = this.#windows.get(this.#stack[i]!)!;
      if (w.state === "normal") {
        this.#focusedId = w.id;
        w.badge = false;
        this.#stack = [...this.#stack.filter((x) => x !== w.id), w.id];
        return;
      }
    }
    this.#focusedId = null;
  }

  #must(id: string): WindowRecord {
    const w = this.#windows.get(id);
    if (!w) throw new KernelError("E_NOTFOUND", `window ${id}`);
    return w;
  }

  #emit(ctx: Ctx, type: string, windowId: string, extra: Record<string, unknown> = {}): void {
    this.#bus.emit({ type, actor: ctx.actor, causeId: ctx.causeId, windowId, ...extra });
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
