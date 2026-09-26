import { KernelError, USER, type KernelEvent } from "@opencoven/cauldron";
import { dialog, esc } from "./dialogs.ts";
import { cap, explain } from "./finder.ts";
import type { Shell } from "./shell.ts";
import { draftKey } from "./storage.ts";
import type { AppView, Menu } from "./types.ts";

const u = { actor: USER };

export class TextEditView implements AppView {
  readonly appId = "textedit";
  readonly el = document.createElement("div");
  path: string | null;
  #nodeId: string | null = null;
  #loadedRev = 0;
  #saved = "";
  #untitled: string;
  #text: HTMLTextAreaElement;
  #banner: HTMLDivElement;
  #hl: HTMLDivElement;
  #shell: Shell;
  /** Own history (spec §7.4: ≥100 steps). Native undo breaks on programmatic value changes. */
  #past: string[] = [];
  #future: string[] = [];
  #last = "";
  #find: { bar: HTMLDivElement; input: HTMLInputElement; count: HTMLSpanElement; idx: number; hits: number[] } | null = null;
  static readonly HISTORY = 500;

  readonly windowId: string;

  constructor(shell: Shell, windowId: string, state: { path?: string | null; untitled?: string }) {
    this.#shell = shell;
    this.windowId = windowId;
    this.el.className = "textedit";
    this.#banner = document.createElement("div");
    this.#banner.className = "banner";
    this.#banner.hidden = true;
    this.#text = document.createElement("textarea");
    this.#text.spellcheck = false;
    this.#text.setAttribute("aria-label", "Document");
    this.#text.oninput = () => {
      this.#past.push(this.#last);
      if (this.#past.length > TextEditView.HISTORY) this.#past.shift();
      this.#future = [];
      this.#last = this.#text.value;
      this.#changed();
    };
    // Highlight layer behind a transparent textarea: find matches stay visible while
    // focus is in the find field (a textarea hides its selection when unfocused).
    const editor = document.createElement("div");
    editor.className = "editor";
    this.#hl = document.createElement("div");
    this.#hl.className = "hl";
    this.#hl.setAttribute("aria-hidden", "true");
    this.#text.addEventListener("scroll", () => {
      this.#hl.scrollTop = this.#text.scrollTop;
      this.#hl.scrollLeft = this.#text.scrollLeft;
    });
    editor.append(this.#hl, this.#text);
    this.el.append(this.#banner, editor);
    this.#untitled = state.untitled ?? shell.nextUntitled();
    this.path = null;
    if (state.path && shell.kernel.vfs.exists(u, state.path)) this.#load(state.path);
    const draft = localStorage.getItem(draftKey(windowId));
    if (draft !== null && draft !== this.#saved) this.#text.value = draft;
    this.#last = this.#text.value;
    this.#retitle();
  }

  get dirty() {
    return this.#text.value !== this.#saved;
  }

  get name() {
    return this.path ? this.path.slice(this.path.lastIndexOf("/") + 1) : this.#untitled;
  }

  persist() {
    return { path: this.path, untitled: this.#untitled };
  }

  menus(): Menu[] {
    return [
      {
        title: "File",
        items: [
          { label: "New", shortcut: "⌘N", action: () => this.#shell.launch("textedit") },
          { label: "Save", shortcut: "⌘S", action: () => void this.save() },
          { label: "Save As…", shortcut: "⇧⌘S", action: () => void this.saveAs() },
        ],
      },
      {
        title: "Edit",
        items: [
          { label: "Undo", shortcut: "⌘Z", disabled: this.#past.length === 0, action: () => this.undo() },
          { label: "Redo", shortcut: "⇧⌘Z", disabled: this.#future.length === 0, action: () => this.redo() },
          { label: "Find…", shortcut: "⌘F", action: () => this.openFind() },
        ],
      },
    ];
  }

  onKey(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "s") {
      void (e.shiftKey ? this.saveAs() : this.save());
      return true;
    }
    if (mod && k === "z") return e.shiftKey ? this.redo() : this.undo(), true;
    if (mod && k === "y") return this.redo(), true;
    if (mod && k === "f") return this.openFind(), true;
    return false;
  }

  undo() {
    const prev = this.#past.pop();
    if (prev === undefined) return;
    this.#future.push(this.#text.value);
    this.#apply(prev);
  }

  redo() {
    const next = this.#future.pop();
    if (next === undefined) return;
    this.#past.push(this.#text.value);
    this.#apply(next);
  }

  #apply(value: string) {
    this.#text.value = value;
    this.#last = value;
    this.#changed();
  }

  #changed() {
    localStorage.setItem(draftKey(this.windowId), this.#text.value);
    this.#retitle();
    if (this.#find) this.#search(false);
  }

  // ---------- find (spec §7.4) ----------

  openFind() {
    if (!this.#find) {
      const bar = document.createElement("div");
      bar.className = "findbar";
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Find");
      input.placeholder = "Find";
      const count = document.createElement("span");
      count.className = "count";
      const btn = (label: string, title: string, fn: () => void) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("aria-label", title);
        b.onclick = fn;
        return b;
      };
      bar.append(input, count, btn("‹", "Previous match", () => this.#step(-1)), btn("›", "Next match", () => this.#step(1)), btn("Done", "Close find", () => this.closeFind()));
      input.oninput = () => this.#search(true);
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); this.#step(e.shiftKey ? -1 : 1); }
        if (e.key === "Escape") { e.preventDefault(); this.closeFind(); }
      };
      this.#find = { bar, input, count, idx: -1, hits: [] };
      this.#banner.after(bar);
    }
    this.#find.input.focus();
    this.#find.input.select();
  }

  closeFind() {
    this.#find?.bar.remove();
    this.#find = null;
    this.#hl.replaceChildren();
    this.#text.focus();
  }

  #search(jump: boolean) {
    const f = this.#find!;
    const q = f.input.value.toLowerCase();
    const hay = this.#text.value.toLowerCase();
    f.hits = [];
    if (q) for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + Math.max(1, q.length))) f.hits.push(i);
    if (f.hits.length === 0) f.idx = -1;
    else if (jump || f.idx < 0 || f.idx >= f.hits.length) f.idx = 0;
    this.#showHit();
  }

  #step(dir: 1 | -1) {
    const f = this.#find;
    if (!f || f.hits.length === 0) return;
    f.idx = (f.idx + dir + f.hits.length) % f.hits.length;
    this.#showHit();
  }

  #showHit() {
    const f = this.#find!;
    f.count.textContent = !f.input.value ? "" : f.hits.length === 0 ? "No matches" : `${f.idx + 1} of ${f.hits.length}`;
    const len = f.input.value.length;
    if (f.idx >= 0) {
      const start = f.hits[f.idx]!;
      this.#text.setSelectionRange(start, start + len);
    }
    // Paint every match; the current one is marked "current".
    const text = this.#text.value;
    const frag = document.createDocumentFragment();
    let at = 0;
    f.hits.forEach((h, i) => {
      frag.append(text.slice(at, h));
      const m = document.createElement("mark");
      if (i === f.idx) m.className = "current";
      m.textContent = text.slice(h, h + len);
      frag.append(m);
      at = h + len;
    });
    frag.append(text.slice(at) + "\n");
    this.#hl.replaceChildren(frag);
    this.#hl.scrollTop = this.#text.scrollTop;
    this.el.querySelector("mark.current")?.scrollIntoView({ block: "nearest" });
  }

  focusText() {
    this.#text.focus();
  }

  #load(path: string) {
    const st = this.#shell.kernel.vfs.stat(u, path);
    const r = this.#shell.kernel.vfs.read(u, path);
    this.path = st.path;
    this.#nodeId = st.node.id;
    this.#loadedRev = r.rev;
    this.#saved = r.content;
    this.#text.value = r.content;
    this.#last = r.content;
    this.#past = [];
    this.#future = [];
    this.#shell.setDocumentPath(this.windowId, st.path);
  }

  #retitle() {
    this.#shell.setTitle(this.windowId, (this.dirty ? "• " : "") + this.name);
  }

  #clearDraft() {
    localStorage.removeItem(draftKey(this.windowId));
  }

  async save(): Promise<boolean> {
    if (!this.path) return this.saveAs();
    try {
      const st = await this.#shell.kernel.vfs.write(u, this.path, this.#text.value, { ifRev: this.#loadedRev });
      this.#afterSave(st.path, st.node.id, st.node.rev);
      return true;
    } catch (err) {
      if (err instanceof KernelError && err.code === "E_CONFLICT") {
        const who = this.#lastWriter();
        const { choice } = await dialog({
          html: `<span class="who">${esc(who)}</span> changed “${esc(this.name)}” since you opened it.`,
          buttons: [
            { id: "cancel", label: "Cancel" },
            { id: "reload", label: "Reload" },
            { id: "overwrite", label: "Overwrite", primary: true },
          ],
        });
        if (choice === "reload") return this.reload(), false;
        if (choice === "overwrite") {
          this.#loadedRev = this.#shell.kernel.vfs.stat(u, this.path).node.rev;
          return this.save();
        }
        return false;
      }
      await this.#error(err);
      return false;
    }
  }

  async saveAs(): Promise<boolean> {
    const { choice, value } = await dialog({
      html: "Save document as:",
      input: { label: "Name (in Documents)", value: this.path ? this.name : `${this.#untitled}.txt` },
      buttons: [{ id: "cancel", label: "Cancel" }, { id: "save", label: "Save", primary: true }],
    });
    if (choice !== "save") return false;
    const target = value.startsWith("/") ? value : `/Documents/${value.trim()}`;
    try {
      const st = await this.#shell.kernel.vfs.create(u, target, "file", { content: this.#text.value, mime: "text/plain" });
      this.#afterSave(st.path, st.node.id, st.node.rev);
      return true;
    } catch (err) {
      await this.#error(err);
      return false;
    }
  }

  reload() {
    if (this.path) this.#load(this.path);
    this.#banner.hidden = true;
    this.#clearDraft();
    this.#retitle();
  }

  #afterSave(path: string, nodeId: string, rev: number) {
    this.path = path;
    this.#nodeId = nodeId;
    this.#loadedRev = rev;
    this.#saved = this.#text.value;
    this.#banner.hidden = true;
    this.#clearDraft();
    this.#shell.setDocumentPath(this.windowId, path);
    this.#retitle();
    this.#shell.persist();
  }

  #lastWriter(): string {
    if (!this.path) return "Someone";
    const by = this.#shell.kernel.vfs.stat(u, this.path).node.modifiedBy;
    return by.kind === "agent" ? cap(by.id) : by.kind === "user" ? "You" : "The system";
  }

  onVfs(e: KernelEvent): void {
    if (!this.path) return;
    const vfs = this.#shell.kernel.vfs;
    const paths = (e.paths as string[] | undefined) ?? [];
    // Followed a rename/move/trash of our file?
    if (!vfs.exists(u, this.path) && paths[0]?.toLowerCase() === this.path.toLowerCase()) {
      const dest = paths[1];
      const candidates = dest === "/Trash" ? [] : [dest, dest && `${dest}/${this.name}`].filter(Boolean) as string[];
      const found = candidates.find((p) => vfs.exists(u, p) && vfs.stat(u, p).node.id === this.#nodeId);
      if (found) {
        const moved = vfs.stat(u, found);
        this.path = moved.path;
        this.#loadedRev = moved.node.rev; // rename/move bumps rev but not content
        this.#shell.setDocumentPath(this.windowId, this.path);
        this.#retitle();
        this.#shell.persist();
        return;
      }
      // trashed or gone: keep content as an untitled, dirty document
      this.path = null;
      this.#saved = "";
      this.#nodeId = null;
      this.#shell.setDocumentPath(this.windowId, undefined);
      this.#showBanner(`The file was moved to the Trash. Your text is kept here, unsaved.`, []);
      this.#retitle();
      return;
    }
    if (!vfs.exists(u, this.path)) return;
    const st = vfs.stat(u, this.path);
    if (st.node.id !== this.#nodeId || st.node.rev <= this.#loadedRev) return;
    if ((st.node.content ?? "") === this.#saved) {
      // Metadata-only change (e.g. case-only rename): adopt the new rev and path quietly.
      this.#loadedRev = st.node.rev;
      if (st.path !== this.path) {
        this.path = st.path;
        this.#shell.setDocumentPath(this.windowId, st.path);
        this.#retitle();
      }
      return;
    }
    if (e.actor.kind === "user" && !this.dirty) {
      this.reload();
      return;
    }
    const who = e.actor.kind === "agent" ? cap(e.actor.id) : e.actor.kind === "user" ? "You (another window)" : "The system";
    this.#showBanner(`Changed by ${who}.`, [
      { label: "Reload", fn: () => this.reload() },
      { label: "Keep mine", fn: () => { this.#banner.hidden = true; this.#loadedRev = st.node.rev; this.#text.focus(); } },
    ]);
  }

  #showBanner(text: string, actions: { label: string; fn: () => void }[]) {
    this.#banner.replaceChildren();
    const span = document.createElement("span");
    span.textContent = text;
    this.#banner.append(span);
    for (const a of actions) {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.onclick = a.fn;
      this.#banner.append(b);
    }
    this.#banner.hidden = false;
  }

  async canClose(): Promise<boolean> {
    if (!this.dirty) {
      this.#clearDraft();
      return true;
    }
    const { choice } = await dialog({
      html: `Do you want to save the changes you made to “${esc(this.name)}”?`,
      buttons: [
        { id: "dontsave", label: "Don't Save" },
        { id: "cancel", label: "Cancel" },
        { id: "save", label: "Save", primary: true },
      ],
    });
    if (choice === "cancel") return false;
    if (choice === "save" && !(await this.save())) return false;
    this.#clearDraft();
    return true;
  }

  async #error(err: unknown) {
    const msg = err instanceof KernelError ? explain(err) : String(err);
    await dialog({ html: esc(msg), buttons: [{ id: "ok", label: "OK", primary: true }] });
  }
}
