import { KernelError, USER, type KernelEvent, type Stat } from "@opencoven/cauldron";
import { dialog, esc } from "./dialogs.ts";
import { makeDraggable, makeDropTarget } from "./dnd.ts";
import type { Shell } from "./shell.ts";
import type { AppView, Menu } from "./types.ts";

type SortKey = "name" | "kind" | "size" | "modified" | "by";
const u = { actor: USER };

type ViewMode = "list" | "icon";

export class FinderView implements AppView {
  readonly appId = "finder";
  readonly el = document.createElement("div");
  path: string;
  #back: string[] = [];
  #sort: { key: SortKey; dir: 1 | -1 } = { key: "name", dir: 1 };
  /** Selection (spec §6.5): a set of names in the current folder, plus the Shift-range anchor. */
  #sel = new Set<string>();
  #anchor: string | null = null;
  #renaming: string | null = null;
  /** View choice per folder (spec §6.3). */
  #views: Record<string, ViewMode> = {};
  #body: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #order: string[] = [];
  #shell: Shell;

  readonly windowId: string;

  constructor(shell: Shell, windowId: string, state: { path?: string; sort?: FinderView["sort"]; views?: Record<string, ViewMode> }) {
    this.#shell = shell;
    this.windowId = windowId;
    this.path = state.path && shell.kernel.vfs.exists(u, state.path) ? state.path : "/Documents";
    if (state.sort) this.#sort = state.sort;
    if (state.views) this.#views = { ...state.views };
    this.el.className = "finder";
    this.render();
  }

  get sort() {
    return this.#sort;
  }

  get view(): ViewMode {
    return this.#views[this.path.toLowerCase()] ?? "list";
  }

  /** Selected names in display order. */
  get selection(): string[] {
    return this.#order.filter((n) => this.#sel.has(n));
  }

  persist() {
    return { path: this.path, sort: this.#sort, views: this.#views };
  }

  menus(): Menu[] {
    const sel = this.selection;
    const one = sel.length === 1 ? sel[0]! : null;
    const any = sel.length > 0;
    return [
      {
        title: "File",
        items: [
          { label: "New Folder", shortcut: "⇧⌘N", action: () => this.newFolder() },
          { label: "Open", shortcut: "⌘O", disabled: !any, action: () => this.openSelection() },
          { label: "Rename", disabled: !one, action: () => one && this.startRename(one) },
          { label: sel.length > 1 ? `Duplicate ${sel.length} Items` : "Duplicate", shortcut: "⌘D", disabled: !any, action: () => this.duplicate(sel) },
          { label: sel.length > 1 ? `Move ${sel.length} Items to Trash` : "Move to Trash", shortcut: "⌘⌫", disabled: !any, action: () => this.trash(sel) },
          { label: "Get Info", shortcut: "⌘I", disabled: !any, action: () => any && this.info(sel[0]!) },
        ],
      },
      {
        title: "Edit",
        items: [{ label: "Select All", shortcut: "⌘A", action: () => this.selectAll() }],
      },
      {
        title: "View",
        items: [
          { label: `${this.view === "icon" ? "✓ " : ""}as Icons`, action: () => this.setView("icon") },
          { label: `${this.view === "list" ? "✓ " : ""}as List`, action: () => this.setView("list") },
        ],
      },
      {
        title: "Go",
        items: [
          { label: "Back", disabled: this.#back.length === 0, action: () => this.back() },
          { label: "Enclosing Folder", disabled: this.path === "/", action: () => this.up() },
          ...["/Documents", "/Desktop", "/Shared", "/Familiars", "/Trash"].map((p) => ({ label: p.slice(1), action: () => this.navigate(p) })),
        ],
      },
    ];
  }

  onKey(e: KeyboardEvent): boolean {
    if (this.#renaming) return false;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && e.shiftKey && k === "n") return void this.newFolder(), true;
    if (mod && k === "a") return this.selectAll(), true;
    if (e.key.startsWith("Arrow")) return this.#arrow(e.key, e.shiftKey), true;
    const sel = this.selection;
    if (sel.length === 0) return false;
    if (e.key === "Enter" || (mod && k === "o")) return this.openSelection(), true;
    if (mod && e.key === "Backspace") return void this.trash(sel), true;
    if (mod && k === "i") return void this.info(sel[0]!), true;
    if (mod && k === "d") return void this.duplicate(sel), true;
    return false;
  }

  onVfs(e: KernelEvent): void {
    if (!this.#shell.kernel.vfs.exists(u, this.path)) this.path = "/Documents";
    void e;
    this.render();
  }

  async canClose() {
    return true;
  }

  // ---------- navigation & view ----------

  navigate(path: string, push = true) {
    if (!this.#shell.kernel.vfs.exists(u, path)) return;
    const st = this.#shell.kernel.vfs.stat(u, path);
    if (st.node.kind !== "folder") return void this.#shell.openFile(st.path);
    if (push && st.path !== this.path) this.#back.push(this.path);
    this.path = st.path;
    this.#sel.clear();
    this.#anchor = null;
    this.render();
    this.#shell.persist();
  }

  back() {
    const prev = this.#back.pop();
    if (prev) this.navigate(prev, false);
  }

  up() {
    if (this.path === "/") return;
    this.navigate(this.path.slice(0, this.path.lastIndexOf("/")) || "/");
  }

  setView(mode: ViewMode) {
    if (mode === "list") delete this.#views[this.path.toLowerCase()];
    else this.#views[this.path.toLowerCase()] = mode;
    this.render();
    this.#shell.persist();
  }

  open(name: string) {
    this.navigate(this.#join(name));
  }

  /** Open every selected file; a single selected folder is entered. */
  openSelection() {
    const sel = this.selection;
    const kinds = new Map(this.#shell.kernel.vfs.list(u, this.path).map((s) => [s.node.name, s.node.kind]));
    if (sel.length === 1 && kinds.get(sel[0]!) === "folder") return this.open(sel[0]!);
    for (const n of sel) if (kinds.get(n) === "file") this.#shell.openFile(this.#join(n));
  }

  // ---------- selection (spec §6.5) ----------

  select(names: Iterable<string>, anchor?: string | null) {
    this.#sel = new Set(names);
    if (anchor !== undefined) this.#anchor = anchor;
    this.#paint();
  }

  selectAll() {
    this.select(this.#order, this.#order[0] ?? null);
  }

  #click(name: string, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(this.#sel);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      this.select(next, name);
    } else if (e.shiftKey && this.#anchor && this.#order.includes(this.#anchor)) {
      const a = this.#order.indexOf(this.#anchor);
      const b = this.#order.indexOf(name);
      this.select(this.#order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      this.select([name], name);
    }
  }

  #arrow(key: string, extend: boolean) {
    if (this.#order.length === 0) return;
    const cur = this.#anchor && this.#order.includes(this.#anchor) ? this.#order.indexOf(this.#anchor) : -1;
    const cols = this.view === "icon" ? this.#columns() : 1;
    const step =
      key === "ArrowDown" ? cols : key === "ArrowUp" ? -cols
      : this.view === "icon" && key === "ArrowRight" ? 1 : this.view === "icon" && key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const next = cur < 0 ? (step > 0 ? 0 : this.#order.length - 1) : Math.min(this.#order.length - 1, Math.max(0, cur + step));
    const name = this.#order[next]!;
    if (extend && cur >= 0) this.select(new Set([...this.#sel, name]), name);
    else this.select([name], name);
    this.#body?.querySelector<HTMLElement>(`[data-name="${cssEsc(name)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  #columns(): number {
    const items = [...(this.#body?.querySelectorAll<HTMLElement>(".ficon") ?? [])];
    if (items.length === 0) return 1;
    const top = items[0]!.offsetTop;
    return Math.max(1, items.filter((i) => i.offsetTop === top).length);
  }

  /** Update selection classes in place — never re-render (that would eat double-clicks). */
  #paint() {
    for (const el of this.#body?.querySelectorAll<HTMLElement>("[data-name]") ?? []) {
      el.classList.toggle("selected", this.#sel.has(el.dataset.name!));
    }
    if (this.#status) {
      const n = this.#order.length;
      const k = this.selection.length;
      this.#status.textContent = `${n} item${n === 1 ? "" : "s"}${k ? `, ${k} selected` : ""}`;
    }
  }

  // ---------- operations ----------

  async newFolder() {
    let name = "untitled folder";
    for (let n = 2; this.#shell.kernel.vfs.exists(u, this.#join(name)); n++) name = `untitled folder ${n}`;
    await this.#run(() => this.#shell.kernel.vfs.create(u, this.#join(name), "folder"));
    this.#sel = new Set([name]);
    this.#anchor = name;
    this.startRename(name);
  }

  startRename(name: string) {
    this.#renaming = name;
    this.render();
    const input = this.el.querySelector<HTMLInputElement>("input.rename");
    input?.focus();
    input?.select();
  }

  async #commitRename(from: string, to: string) {
    this.#renaming = null;
    to = to.trim();
    if (to && to !== from) {
      const ok = await this.#run(() => this.#shell.kernel.vfs.rename(u, this.#join(from), to));
      if (ok) {
        this.#sel = new Set([to]);
        this.#anchor = to;
      }
    }
    this.render();
  }

  async duplicate(names: string | string[]) {
    for (const n of typeof names === "string" ? [names] : names) {
      if (!(await this.#run(() => this.#shell.kernel.vfs.copy(u, this.#join(n), this.path)))) break;
    }
  }

  async trash(names: string | string[]) {
    for (const n of typeof names === "string" ? [names] : names) {
      if (!(await this.#run(() => this.#shell.kernel.vfs.trash(u, this.#join(n))))) break;
      this.#sel.delete(n);
    }
  }

  async info(name: string) {
    const st = this.#shell.kernel.vfs.stat(u, this.#join(name));
    const n = st.node;
    const who = (a: { kind: string; id: string }) => (a.kind === "agent" ? `<span class="who">${esc(cap(a.id))}</span> (familiar)` : a.kind === "user" ? "You" : "System");
    const when = (t: number) => esc(new Date(t).toLocaleString());
    await dialog({
      kind: "info",
      html: `<div class="info"><strong>${esc(n.name)}</strong><dl>
        <dt>Kind</dt><dd>${n.kind === "folder" ? "Folder" : esc(n.mime ?? "Document")}</dd>
        <dt>Size</dt><dd>${n.kind === "folder" ? "—" : `${n.size} bytes`}</dd>
        <dt>Where</dt><dd>${esc(st.path)}</dd>
        <dt>Created</dt><dd>${when(n.createdAt)}</dd>
        <dt>Created by</dt><dd data-field="createdBy">${who(n.createdBy)}</dd>
        <dt>Modified</dt><dd>${when(n.modifiedAt)}</dd>
        <dt>Modified by</dt><dd data-field="modifiedBy">${who(n.modifiedBy)}</dd>
        <dt>Revision</dt><dd>${n.rev}</dd>
        ${n.origin?.taskId ? `<dt>Task</dt><dd>${esc(n.origin.taskId)}</dd>` : ""}
      </dl></div>`,
      buttons: [{ id: "ok", label: "OK", primary: true }],
    });
  }

  #join(name: string) {
    return this.path === "/" ? `/${name}` : `${this.path}/${name}`;
  }

  async #run(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      const msg = err instanceof KernelError ? explain(err) : String(err);
      await dialog({ html: esc(msg), buttons: [{ id: "ok", label: "OK", primary: true }] });
      return false;
    }
  }

  #rows(): Stat[] {
    const rows = this.#shell.kernel.vfs.list(u, this.path);
    const { key, dir } = this.#sort;
    const val = (s: Stat): string | number =>
      key === "name" ? s.node.name.toLowerCase()
      : key === "kind" ? s.node.kind
      : key === "size" ? s.node.size
      : key === "modified" ? s.node.modifiedAt
      : `${s.node.modifiedBy.kind}:${s.node.modifiedBy.id}`;
    return rows.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
  }

  // ---------- rendering ----------

  /** Wire the per-item behaviour shared by list rows and icons. */
  #item(el: HTMLElement, s: Stat) {
    const n = s.node;
    el.dataset.name = n.name;
    el.dataset.kind = n.kind;
    if (this.#sel.has(n.name)) el.classList.add("selected");
    el.addEventListener("click", (e) => {
      if (this.#renaming === n.name) return;
      if (!(e.metaKey || e.ctrlKey || e.shiftKey) && this.#sel.size === 1 && this.#sel.has(n.name)) return;
      this.#click(n.name, e);
    });
    el.ondblclick = () => this.open(n.name);
    if (this.#renaming !== n.name) {
      // Dragging a selected item carries the whole selection.
      makeDraggable(el, () => (this.#sel.has(n.name) ? this.selection : [n.name]).map((x) => this.#join(x)).join("\n"));
    }
    if (n.kind === "folder") makeDropTarget(this.#shell, el, () => s.path, { stop: true });
  }

  #renameInput(n: Stat["node"]) {
    const input = document.createElement("input");
    input.className = "rename";
    input.value = n.name;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void this.#commitRename(n.name, input.value);
      if (e.key === "Escape") { this.#renaming = null; this.render(); }
    };
    input.onblur = () => { if (this.#renaming === n.name) void this.#commitRename(n.name, input.value); };
    return input;
  }

  render() {
    const rows = this.#rows();
    this.#order = rows.map((s) => s.node.name);
    for (const n of [...this.#sel]) if (!this.#order.includes(n)) this.#sel.delete(n);
    this.el.replaceChildren();
    const bar = document.createElement("div");
    bar.className = "toolbar";
    const btn = (label: string, title: string, fn: () => void, disabled = false, pressed?: boolean) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
      b.disabled = disabled;
      b.onclick = fn;
      bar.append(b);
    };
    btn("◀", "Back", () => this.back(), this.#back.length === 0);
    btn("▲", "Enclosing Folder", () => this.up(), this.path === "/");
    btn("▦", "Icon view", () => this.setView("icon"), false, this.view === "icon");
    btn("☰", "List view", () => this.setView("list"), false, this.view === "list");
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = this.path;
    path.title = "Click to type a path";
    path.onclick = () => {
      const input = document.createElement("input");
      input.className = "path";
      input.value = this.path;
      input.onkeydown = (e) => {
        if (e.key === "Enter") this.navigate(input.value);
        if (e.key === "Escape") this.render();
        e.stopPropagation();
      };
      input.onblur = () => this.render();
      path.replaceWith(input);
      input.focus();
      input.select();
    };
    bar.append(path);
    btn("New Folder", "New Folder", () => void this.newFolder());
    this.el.append(bar);

    const scroll = document.createElement("div");
    scroll.className = "scroll";
    makeDropTarget(this.#shell, scroll, () => this.path);
    this.#body = this.view === "icon" ? this.#renderIcons(rows) : this.#renderList(rows);
    scroll.append(this.#body);
    this.#status = document.createElement("div");
    this.#status.className = "status";
    this.el.append(scroll, this.#status);
    this.el.dataset.view = this.view;
    this.#paint();
    this.#shell.setTitle(this.windowId, this.path === "/" ? "Covenstead" : this.path.slice(this.path.lastIndexOf("/") + 1));
  }

  #renderList(rows: Stat[]): HTMLElement {
    const table = document.createElement("table");
    table.className = "list";
    const head = document.createElement("tr");
    const cols: [SortKey, string][] = [["name", "Name"], ["kind", "Kind"], ["size", "Size"], ["modified", "Modified"], ["by", "By"]];
    for (const [key, label] of cols) {
      const th = document.createElement("th");
      th.textContent = label + (this.#sort.key === key ? (this.#sort.dir === 1 ? " ▲" : " ▼") : "");
      th.dataset.sort = key;
      th.onclick = () => {
        this.#sort = this.#sort.key === key ? { key, dir: (this.#sort.dir * -1) as 1 | -1 } : { key, dir: 1 };
        this.render();
        this.#shell.persist();
      };
      head.append(th);
    }
    const thead = document.createElement("thead");
    thead.append(head);
    const tbody = document.createElement("tbody");
    for (const s of rows) {
      const n = s.node;
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      if (this.#renaming === n.name) name.append(this.#renameInput(n));
      else name.textContent = (n.kind === "folder" ? "▣ " : "▤ ") + n.name;
      const by = n.modifiedBy;
      tr.append(
        name,
        td(n.kind === "folder" ? "Folder" : "Document"),
        td(n.kind === "folder" ? "—" : fmtSize(n.size)),
        td(new Date(n.modifiedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })),
        td(by.kind === "agent" ? cap(by.id) : by.kind === "user" ? "You" : "System", by.kind === "agent" ? "by-agent" : ""),
      );
      this.#item(tr, s);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }

  #renderIcons(rows: Stat[]): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "icons";
    for (const s of rows) {
      const n = s.node;
      const cell = document.createElement("div");
      cell.className = "ficon";
      const glyph = document.createElement("div");
      glyph.className = "glyph";
      glyph.textContent = n.kind === "folder" ? "▣" : "▤";
      const label = document.createElement("div");
      label.className = "label";
      if (this.#renaming === n.name) label.append(this.#renameInput(n));
      else label.textContent = n.name;
      if (n.modifiedBy.kind === "agent") {
        cell.title = `Last changed by ${cap(n.modifiedBy.id)}`;
        cell.classList.add("by-agent");
      }
      cell.append(glyph, label);
      this.#item(cell, s);
      grid.append(cell);
    }
    this.#marquee(grid);
    return grid;
  }

  /** Rubber-band selection on the icon grid background (spec §6.5). */
  #marquee(grid: HTMLElement) {
    grid.addEventListener("pointerdown", (e) => {
      if (e.target !== grid || e.button !== 0) return;
      e.preventDefault();
      const additive = e.metaKey || e.ctrlKey || e.shiftKey;
      const base = additive ? new Set(this.#sel) : new Set<string>();
      if (!additive) this.select([], null);
      const box = grid.getBoundingClientRect();
      const x0 = e.clientX - box.left + grid.scrollLeft;
      const y0 = e.clientY - box.top + grid.scrollTop;
      const band = document.createElement("div");
      band.className = "marquee";
      grid.append(band);
      grid.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const x1 = m.clientX - box.left + grid.scrollLeft;
        const y1 = m.clientY - box.top + grid.scrollTop;
        const r = { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
        Object.assign(band.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
        const hit = new Set(base);
        for (const icon of grid.querySelectorAll<HTMLElement>(".ficon")) {
          const il = icon.offsetLeft, it = icon.offsetTop, ir = il + icon.offsetWidth, ib = it + icon.offsetHeight;
          if (il < r.r && ir > r.l && it < r.b && ib > r.t) hit.add(icon.dataset.name!);
        }
        this.select(hit, this.#order.find((n) => hit.has(n)) ?? null);
      };
      const up = () => {
        band.remove();
        grid.removeEventListener("pointermove", move);
        grid.removeEventListener("pointerup", up);
      };
      grid.addEventListener("pointermove", move);
      grid.addEventListener("pointerup", up);
    });
  }
}

const cssEsc = (s: string) => CSS.escape(s);

const td = (text: string, cls = "") => {
  const el = document.createElement("td");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
};
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function explain(err: KernelError): string {
  switch (err.code) {
    case "E_EXISTS": return `An item with that name already exists.`;
    case "E_READONLY": return `That item can't be changed.`;
    case "E_CYCLE": return `A folder can't be moved inside itself.`;
    case "E_INVALID_NAME": return `That name isn't allowed.`;
    case "E_QUOTA": return `There isn't enough storage space.`;
    case "E_CONFLICT": return `Someone else changed this since you opened it.`;
    case "E_CONSENT": return `Not allowed.`;
    default: return err.message;
  }
}
