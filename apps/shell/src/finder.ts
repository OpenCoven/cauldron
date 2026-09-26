import { KernelError, USER, type KernelEvent, type Stat } from "@opencoven/cauldron";
import { dialog, esc } from "./dialogs.ts";
import type { Shell } from "./shell.ts";
import type { AppView, Menu } from "./types.ts";

type SortKey = "name" | "kind" | "size" | "modified" | "by";
const u = { actor: USER };

export class FinderView implements AppView {
  readonly appId = "finder";
  readonly el = document.createElement("div");
  path: string;
  #back: string[] = [];
  #sort: { key: SortKey; dir: 1 | -1 } = { key: "name", dir: 1 };
  #selected: string | null = null;
  #renaming: string | null = null;
  #shell: Shell;

  readonly windowId: string;

  constructor(shell: Shell, windowId: string, state: { path?: string; sort?: FinderView["sort"] }) {
    this.#shell = shell;
    this.windowId = windowId;
    this.path = state.path && shell.kernel.vfs.exists(u, state.path) ? state.path : "/Documents";
    if (state.sort) this.#sort = state.sort;
    this.el.className = "finder";
    this.render();
  }

  get sort() {
    return this.#sort;
  }

  persist() {
    return { path: this.path, sort: this.#sort };
  }

  menus(): Menu[] {
    const sel = this.#selected;
    return [
      {
        title: "File",
        items: [
          { label: "New Folder", shortcut: "⇧⌘N", action: () => this.newFolder() },
          { label: "Open", shortcut: "⌘O", disabled: !sel, action: () => sel && this.open(sel) },
          { label: "Rename", disabled: !sel, action: () => sel && this.startRename(sel) },
          { label: "Duplicate", shortcut: "⌘D", disabled: !sel, action: () => sel && this.duplicate(sel) },
          { label: "Move to Trash", shortcut: "⌘⌫", disabled: !sel, action: () => sel && this.trash(sel) },
          { label: "Get Info", shortcut: "⌘I", disabled: !sel, action: () => sel && this.info(sel) },
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
    if (mod && e.shiftKey && e.key.toLowerCase() === "n") return void this.newFolder(), true;
    if (!this.#selected) return false;
    if (e.key === "Enter" || (mod && e.key.toLowerCase() === "o")) return void this.open(this.#selected), true;
    if (mod && e.key === "Backspace") return void this.trash(this.#selected), true;
    if (mod && e.key.toLowerCase() === "i") return void this.info(this.#selected), true;
    if (mod && e.key.toLowerCase() === "d") return void this.duplicate(this.#selected), true;
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

  navigate(path: string, push = true) {
    if (!this.#shell.kernel.vfs.exists(u, path)) return;
    const st = this.#shell.kernel.vfs.stat(u, path);
    if (st.node.kind !== "folder") return void this.#shell.openFile(st.path);
    if (push && st.path !== this.path) this.#back.push(this.path);
    this.path = st.path;
    this.#selected = null;
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

  open(name: string) {
    this.navigate(this.#join(name));
  }

  async newFolder() {
    let name = "untitled folder";
    for (let n = 2; this.#shell.kernel.vfs.exists(u, this.#join(name)); n++) name = `untitled folder ${n}`;
    await this.#run(() => this.#shell.kernel.vfs.create(u, this.#join(name), "folder"));
    this.#selected = name;
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
      if (ok) this.#selected = to;
    }
    this.render();
  }

  async duplicate(name: string) {
    await this.#run(() => this.#shell.kernel.vfs.copy(u, this.#join(name), this.path));
  }

  async trash(name: string) {
    const ok = await this.#run(() => this.#shell.kernel.vfs.trash(u, this.#join(name)));
    if (ok) this.#selected = null;
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

  render() {
    const rows = this.#rows();
    this.el.replaceChildren();
    const bar = document.createElement("div");
    bar.className = "toolbar";
    const btn = (label: string, title: string, fn: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.disabled = disabled;
      b.onclick = fn;
      bar.append(b);
    };
    btn("◀", "Back", () => this.back(), this.#back.length === 0);
    btn("▲", "Enclosing Folder", () => this.up(), this.path === "/");
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
      tr.dataset.name = n.name;
      tr.dataset.kind = n.kind;
      if (n.name === this.#selected) tr.className = "selected";
      const name = document.createElement("td");
      if (this.#renaming === n.name) {
        const input = document.createElement("input");
        input.className = "rename";
        input.value = n.name;
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter") void this.#commitRename(n.name, input.value);
          if (e.key === "Escape") { this.#renaming = null; this.render(); }
        };
        input.onblur = () => { if (this.#renaming === n.name) void this.#commitRename(n.name, input.value); };
        name.append(input);
      } else {
        name.textContent = (n.kind === "folder" ? "▣ " : "▤ ") + n.name;
      }
      const by = n.modifiedBy;
      const cells = [
        name,
        td(n.kind === "folder" ? "Folder" : "Document"),
        td(n.kind === "folder" ? "—" : fmtSize(n.size)),
        td(new Date(n.modifiedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })),
        td(by.kind === "agent" ? cap(by.id) : by.kind === "user" ? "You" : "System", by.kind === "agent" ? "by-agent" : ""),
      ];
      tr.append(...cells);
      tr.onclick = () => {
        if (this.#selected === n.name && this.#renaming !== n.name) return;
        this.#selected = n.name;
        this.render();
      };
      tr.ondblclick = () => this.open(n.name);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    scroll.append(table);
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    this.el.append(scroll, status);
    this.#shell.setTitle(this.windowId, this.path === "/" ? "Covenstead" : this.path.slice(this.path.lastIndexOf("/") + 1));
  }
}

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
