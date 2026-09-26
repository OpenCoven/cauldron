import { USER } from "@opencoven/cauldron";
import { makeDraggable, makeDropTarget } from "./dnd.ts";
import type { Shell } from "./shell.ts";

const u = { actor: USER };

/**
 * The desktop background: /Desktop's contents as icons in a right-aligned
 * grid, plus the Trash bottom-right (spec §6.9). Sits under every window.
 */
export class DesktopIcons {
  readonly el = document.createElement("div");
  #shell: Shell;
  #selected: string | null = null;

  constructor(shell: Shell) {
    this.#shell = shell;
    this.el.id = "desktop-icons";
    makeDropTarget(shell, this.el, () => "/Desktop");
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.select(null);
    });
  }

  /** Toggle selection in place — re-rendering here would swap the element mid double-click. */
  select(name: string | null) {
    this.#selected = name;
    for (const el of this.el.querySelectorAll<HTMLElement>(".desk-icon")) {
      el.classList.toggle("selected", el.dataset.name === name);
    }
  }

  render() {
    const vfs = this.#shell.kernel.vfs;
    const items = vfs.exists(u, "/Desktop") ? vfs.list(u, "/Desktop") : [];
    const trashFull = vfs.exists(u, "/Trash") && vfs.list(u, "/Trash").length > 0;
    this.el.replaceChildren();
    items.forEach((s, i) => {
      const icon = document.createElement("div");
      icon.className = "desk-icon" + (s.node.name === this.#selected ? " selected" : "");
      icon.dataset.name = s.node.name;
      icon.dataset.kind = s.node.kind;
      icon.style.top = `${12 + i * 92}px`;
      icon.innerHTML = `<div class="glyph">${s.node.kind === "folder" ? "▣" : "▤"}</div><div class="label"></div>`;
      icon.querySelector(".label")!.textContent = s.node.name;
      icon.onpointerdown = () => this.select(s.node.name);
      icon.ondblclick = () =>
        s.node.kind === "folder" ? this.#shell.launch("finder", { path: s.path }) : this.#shell.openFile(s.path);
      makeDraggable(icon, () => s.path);
      if (s.node.kind === "folder") makeDropTarget(this.#shell, icon, () => s.path, { stop: true });
      this.el.append(icon);
    });
    const trash = document.createElement("div");
    trash.className = "desk-icon trash";
    trash.dataset.name = "Trash";
    trash.dataset.full = String(trashFull);
    trash.innerHTML = `<div class="glyph">${trashFull ? "▦" : "□"}</div><div class="label">Trash</div>`;
    trash.ondblclick = () => this.#shell.launch("finder", { path: "/Trash" });
    makeDropTarget(this.#shell, trash, () => "trash", { stop: true });
    this.el.append(trash);
  }
}
