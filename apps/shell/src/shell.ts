import {
  AppRegistry,
  USER,
  createKernel,
  type AppManifest,
  type ConsentRequest,
  type Kernel,
  type KernelEvent,
  type WindowRecord,
  type WmSnapshot,
} from "@opencoven/cauldron";
import { dialog, esc } from "./dialogs.ts";
import { DesktopIcons } from "./desktop-icons.ts";
import { FinderView, cap } from "./finder.ts";
import { DESKTOP_KEY, LocalStorageAdapter } from "./storage.ts";
import { TextEditView } from "./textedit.ts";
import type { AppView, Menu } from "./types.ts";

const u = { actor: USER };

export const FINDER: AppManifest = {
  id: "finder",
  name: "Finder",
  singleton: true,
  opensTypes: [],
  defaultWindow: { w: 640, h: 400 },
  minWindow: { w: 360, h: 220 },
};
export const TEXTEDIT: AppManifest = {
  id: "textedit",
  name: "TextEdit",
  singleton: false,
  opensTypes: ["text/plain", "text/markdown", ".txt", ".md"],
  defaultWindow: { w: 560, h: 400 },
  minWindow: { w: 320, h: 200 },
};

interface DesktopState {
  version: 2;
  wm: WmSnapshot;
  views: Record<string, { appId: string } & Record<string, unknown>>;
}

const VERBS: Record<string, string> = {
  "vfs.create": "create",
  "vfs.write": "change",
  "vfs.rename": "rename",
  "vfs.move": "move",
  "vfs.copy": "copy into",
  "vfs.trash": "move to the Trash",
  "vfs.restore": "restore",
  "vfs.emptyTrash": "empty",
};

export class Shell {
  kernel: Kernel;
  #views = new Map<string, AppView>();
  #els = new Map<string, HTMLElement>();
  #untitled = 0;
  #openMenu: string | null = null;
  #restoring = false;
  icons!: DesktopIcons;

  readonly desktop: HTMLElement;
  readonly menubar: HTMLElement;

  constructor(desktop: HTMLElement, menubar: HTMLElement) {
    this.desktop = desktop;
    this.menubar = menubar;
    this.kernel = createKernel({
      storage: new LocalStorageAdapter(),
      viewport: { w: innerWidth, h: innerHeight },
      decideConsent: (r) => this.#consent(r),
    });
    this.kernel.apps.register(FINDER);
    this.kernel.apps.register(TEXTEDIT);
    this.icons = new DesktopIcons(this);
    this.desktop.append(this.icons.el);
    this.kernel.bus.subscribe((e) => this.#onEvent(e));
    addEventListener("resize", () => {
      this.kernel.wm.setViewport({ w: innerWidth, h: innerHeight });
      this.render();
    });
    addEventListener("keydown", (e) => this.#onKey(e));
    addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".menu")) this.#closeMenus();
    });
  }

  boot() {
    this.#restoring = true;
    const raw = localStorage.getItem(DESKTOP_KEY);
    const saved = raw ? (JSON.parse(raw) as DesktopState) : null;
    if (saved?.version === 2) {
      this.kernel.wm.restore(saved.wm);
      for (const w of this.kernel.wm.list()) this.#createView(w, saved.views[w.id] ?? { appId: w.appId });
    }
    this.#restoring = false;
    if (this.kernel.wm.list().length === 0) this.launch("finder", { path: "/Documents" });
    this.icons.render();
    this.render();
    this.persist();
  }

  // ---------- apps ----------

  launch(appId: string, state: Record<string, unknown> = {}) {
    const app = this.kernel.apps.get(appId);
    const pending = { ...state };
    this.#pending = pending;
    const w = this.kernel.wm.open(u, {
      instanceId: app.singleton ? app.id : crypto.randomUUID(),
      appId: app.id,
      title: app.name,
      defaultSize: app.defaultWindow,
      minSize: app.minWindow,
      documentPath: typeof state.path === "string" ? state.path : undefined,
    });
    this.#pending = null;
    const view = this.#views.get(w.id);
    if (view instanceof TextEditView) view.focusText();
    return w.id;
  }

  #pending: Record<string, unknown> | null = null;

  openFile(path: string) {
    const st = this.kernel.vfs.stat(u, path);
    for (const [id, v] of this.#views) {
      if (v instanceof TextEditView && v.path === st.path) return this.kernel.wm.focus(u, id);
    }
    const app = this.kernel.apps.opener(st.node.name, st.node.mime);
    if (!app) {
      return void dialog({
        html: `No application can open “${esc(st.node.name)}”.`,
        buttons: [{ id: "ok", label: "OK", primary: true }],
      });
    }
    this.launch(app.id, { path: st.path });
  }

  nextUntitled() {
    this.#untitled++;
    return this.#untitled === 1 ? "Untitled" : `Untitled ${this.#untitled}`;
  }

  setTitle(windowId: string, title: string) {
    if (this.kernel.wm.list().some((w) => w.id === windowId)) this.kernel.wm.setTitle(u, windowId, title);
  }

  setDocumentPath(windowId: string, path: string | undefined) {
    if (this.kernel.wm.list().some((w) => w.id === windowId)) this.kernel.wm.setDocumentPath(u, windowId, path);
  }

  #createView(w: WindowRecord, state: Record<string, unknown>) {
    const s = { ...state, path: state.path ?? w.documentPath };
    const view: AppView =
      w.appId === "finder"
        ? new FinderView(this, w.id, s as { path?: string })
        : new TextEditView(this, w.id, s as { path?: string });
    this.#views.set(w.id, view);
  }

  async close(windowId: string) {
    const view = this.#views.get(windowId);
    if (view && !(await view.canClose())) return;
    this.#views.delete(windowId);
    this.kernel.wm.close(u, windowId);
  }

  // ---------- events ----------

  #onEvent(e: KernelEvent) {
    if (e.type === "window:opened") {
      const w = this.kernel.wm.get(e.windowId as string);
      if (!this.#views.has(w.id)) this.#createView(w, this.#pending ?? {});
    }
    if (e.type === "vfs:changed") {
      for (const v of this.#views.values()) v.onVfs(e);
      this.icons.render();
    }
    if (e.type.startsWith("window:")) {
      this.render();
      if (!this.#restoring) this.persist();
    }
  }

  persist() {
    const views: DesktopState["views"] = {};
    for (const [id, v] of this.#views) views[id] = { appId: v.appId, ...v.persist() };
    const state: DesktopState = { version: 2, wm: this.kernel.wm.snapshot(), views };
    localStorage.setItem(DESKTOP_KEY, JSON.stringify(state));
  }

  async #consent(r: ConsentRequest): Promise<"granted" | "denied"> {
    const verb = VERBS[r.action] ?? r.action;
    const { choice } = await dialog({
      kind: "consent",
      html: `<span class="who">${esc(cap(r.actor.id))}</span> wants to ${esc(verb)} <code>${esc(r.target)}</code>${r.reason ? ` — ${esc(r.reason)}` : ""}.`,
      buttons: [
        { id: "deny", label: "Not now" },
        { id: "allow", label: "Allow", primary: true },
      ],
    });
    return choice === "allow" ? "granted" : "denied";
  }

  #onKey(e: KeyboardEvent) {
    if (document.getElementById("modal-root")!.childElementCount > 0) return;
    const id = this.kernel.wm.focusedId;
    const view = id ? this.#views.get(id) : undefined;
    if (view?.onKey?.(e)) return e.preventDefault();
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "w" && id) return e.preventDefault(), void this.close(id);
    if (k === "m" && id) return e.preventDefault(), this.kernel.wm.minimize(u, id);
    if (k === "n" && !e.shiftKey) return e.preventDefault(), void this.launch("textedit");
  }

  // ---------- rendering ----------

  render() {
    const wm = this.kernel.wm;
    const wins = wm.list();
    const live = new Set(wins.map((w) => w.id));
    for (const [id, el] of this.#els) if (!live.has(id)) (el.remove(), this.#els.delete(id));
    wins.forEach((w, z) => {
      let el = this.#els.get(w.id);
      if (!el) {
        el = this.#frame(w);
        this.#els.set(w.id, el);
        this.desktop.append(el);
      }
      const view = this.#views.get(w.id);
      const content = el.querySelector(".content")!;
      if (view && view.el.parentElement !== content) content.append(view.el);
      const y = w.rect.y - wm.desktopArea.y;
      Object.assign(el.style, { left: `${w.rect.x}px`, top: `${y}px`, width: `${w.rect.w}px`, height: `${w.rect.h}px`, zIndex: String(z + 1) });
      el.dataset.state = w.state;
      el.dataset.focused = String(wm.focusedId === w.id);
      el.dataset.badge = String(w.badge);
      el.dataset.ownerKind = w.ownerActor.kind;
      el.dataset.owner = w.ownerActor.id;
      el.querySelector(".title")!.textContent = w.title;
      const owner = el.querySelector<HTMLElement>(".owner")!;
      owner.hidden = w.ownerActor.kind !== "agent";
      owner.querySelector(".who")!.textContent = cap(w.ownerActor.id);
      owner.querySelector(".what")!.textContent = w.status ? ` · ${w.status}` : "";
      owner.title = `${cap(w.ownerActor.id)}${w.status ? ` · ${w.status}` : ""}`;
      if (w.peek) el.dataset.peek = w.peek;
      else delete el.dataset.peek;
      el.querySelector<HTMLElement>(".badge")!.hidden = !w.badge;
      el.querySelector<HTMLElement>(".resize")!.hidden = wm.isSmall || !w.flags.resizable;
    });
    this.#renderMenus();
  }

  #frame(w: WindowRecord): HTMLElement {
    const el = document.createElement("section");
    el.className = "win";
    el.dataset.windowId = w.id;
    el.dataset.app = w.appId;
    el.setAttribute("aria-label", w.title);
    el.innerHTML = `<div class="titlebar"><span class="controls"><button class="close" aria-label="Close"></button><button class="min" aria-label="Minimize"></button><button class="zoom" aria-label="Zoom"></button></span><span class="badge" title="Opened by a familiar" hidden></span><span class="title"></span><span class="owner" hidden><span class="who"></span><span class="what"></span></span></div><div class="content"></div><div class="resize" aria-hidden="true"></div>`;
    const wm = this.kernel.wm;
    el.addEventListener("pointerdown", () => {
      if (wm.focusedId !== w.id) wm.focus(u, w.id);
    }, true);
    el.querySelector<HTMLButtonElement>(".close")!.onclick = () => void this.close(w.id);
    el.querySelector<HTMLButtonElement>(".min")!.onclick = () => wm.minimize(u, w.id);
    el.querySelector<HTMLButtonElement>(".zoom")!.onclick = () => wm.zoom(u, w.id);
    this.#drag(el.querySelector(".titlebar")!, w.id, (dx, dy, start) => wm.move(u, w.id, start.x + dx, start.y + dy));
    this.#drag(el.querySelector(".resize")!, w.id, (dx, dy, start) => wm.resize(u, w.id, start.w + dx, start.h + dy));
    return el;
  }

  #drag(handle: HTMLElement, id: string, apply: (dx: number, dy: number, start: { x: number; y: number; w: number; h: number }) => void) {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      // Stop native drag/selection: once the window moves, the browser would otherwise
      // hit-test the original press point and start dragging whatever is now beneath it.
      e.preventDefault();
      const start = { ...this.kernel.wm.get(id).rect };
      const ox = e.clientX;
      const oy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => apply(m.clientX - ox, m.clientY - oy, start);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  #menus(): Menu[] {
    const id = this.kernel.wm.focusedId;
    const view = id ? this.#views.get(id) : undefined;
    const finder = [...this.#views.values()].find((v) => v instanceof FinderView);
    const wins = this.kernel.wm.list();
    return [
      {
        title: "✦",
        items: [
          { label: "About Covenstead", action: () => void dialog({ html: "Covenstead — the desktop where you can see your familiars work. Kernel: Cauldron (P0).", buttons: [{ id: "ok", label: "OK", primary: true }] }) },
          { label: "New Finder Window", action: () => void this.launch("finder", { path: "/Documents" }) },
          { label: "New TextEdit Document", shortcut: "⌘N", action: () => void this.launch("textedit") },
          { label: "Reset Desktop…", action: () => void this.#reset() },
        ],
      },
      ...(view ?? finder)?.menus() ?? [],
      {
        title: "Window",
        items: [
          { label: "Minimize", shortcut: "⌘M", disabled: !id, action: () => id && this.kernel.wm.minimize(u, id) },
          { label: "Close", shortcut: "⌘W", disabled: !id, action: () => id && void this.close(id) },
          ...wins.map((w) => ({
            label: `${w.state === "minimized" ? "◇ " : w.id === id ? "✓ " : "  "}${w.title}${w.ownerActor.kind === "agent" ? ` (${cap(w.ownerActor.id)})` : ""}`,
            action: () => this.kernel.wm.focus(u, w.id),
          })),
        ],
      },
    ];
  }

  #renderMenus() {
    const id = this.kernel.wm.focusedId;
    const appName = id ? this.kernel.apps.get(this.kernel.wm.get(id).appId).name : "Finder";
    this.menubar.replaceChildren();
    const menus = this.#menus();
    menus.forEach((m, i) => {
      const wrap = document.createElement("div");
      wrap.className = "menu" + (this.#openMenu === m.title ? " open" : "");
      const t = document.createElement("button");
      t.className = "menu-title";
      t.textContent = m.title;
      t.setAttribute("aria-haspopup", "true");
      t.onpointerdown = (e) => {
        e.preventDefault();
        this.#openMenu = this.#openMenu === m.title ? null : m.title;
        this.#renderMenus();
      };
      wrap.append(t);
      const items = document.createElement("div");
      items.className = "menu-items";
      items.setAttribute("role", "menu");
      for (const it of m.items) {
        const b = document.createElement("button");
        b.setAttribute("role", "menuitem");
        b.textContent = it.label + (it.shortcut ? ` ${it.shortcut}` : "");
        b.disabled = Boolean(it.disabled);
        b.onclick = () => {
          this.#closeMenus();
          void it.action();
        };
        items.append(b);
      }
      wrap.append(items);
      this.menubar.append(wrap);
      if (i === 0) {
        const name = document.createElement("span");
        name.className = "menu-title app-name";
        name.style.cssText = "display:flex;align-items:center;padding:0 10px";
        name.textContent = appName;
        this.menubar.append(name);
      }
    });
  }

  #closeMenus() {
    if (this.#openMenu === null) return;
    this.#openMenu = null;
    this.#renderMenus();
  }

  async #reset() {
    const { choice } = await dialog({
      html: "Reset the desktop? Every file and window returns to its first-boot state.",
      buttons: [{ id: "cancel", label: "Cancel" }, { id: "reset", label: "Reset", primary: true }],
    });
    if (choice !== "reset") return;
    localStorage.clear();
    location.reload();
  }

  /** Test/dev harness: act as a familiar through the public command bus. */
  get registry(): AppRegistry {
    return this.kernel.apps;
  }
}
