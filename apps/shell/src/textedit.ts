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
  #shell: Shell;

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
      localStorage.setItem(draftKey(this.windowId), this.#text.value);
      this.#retitle();
    };
    this.el.append(this.#banner, this.#text);
    this.#untitled = state.untitled ?? shell.nextUntitled();
    this.path = null;
    if (state.path && shell.kernel.vfs.exists(u, state.path)) this.#load(state.path);
    const draft = localStorage.getItem(draftKey(windowId));
    if (draft !== null && draft !== this.#saved) this.#text.value = draft;
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
    ];
  }

  onKey(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      void (e.shiftKey ? this.saveAs() : this.save());
      return true;
    }
    return false;
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
        this.path = vfs.stat(u, found).path;
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
