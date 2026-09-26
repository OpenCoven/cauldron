import { KernelError, USER } from "@opencoven/cauldron";
import { dialog, esc } from "./dialogs.ts";
import { explain } from "./finder.ts";
import type { Shell } from "./shell.ts";

/** Drag payload: VFS paths, newline-separated. */
export const DRAG_MIME = "application/x-cauldron-paths";
const u = { actor: USER };

export function makeDraggable(el: HTMLElement, path: () => string) {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer!.setData(DRAG_MIME, path());
    e.dataTransfer!.effectAllowed = "copyMove";
  });
}

export const carriesPaths = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes(DRAG_MIME));

/**
 * Make `el` a drop target. `dest()` names the folder (or "trash").
 * Plain drop moves; Alt/Option-drop copies (spec §6.7).
 */
export function makeDropTarget(shell: Shell, el: HTMLElement, dest: () => string | "trash", opts: { stop?: boolean } = {}) {
  el.addEventListener("dragover", (e) => {
    if (!carriesPaths(e)) return;
    e.preventDefault();
    if (opts.stop) e.stopPropagation();
    e.dataTransfer!.dropEffect = e.altKey ? "copy" : "move";
    el.classList.add("drop-hover");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
  el.addEventListener("drop", (e) => {
    if (!carriesPaths(e)) return;
    e.preventDefault();
    if (opts.stop) e.stopPropagation();
    el.classList.remove("drop-hover");
    const paths = e.dataTransfer!.getData(DRAG_MIME).split("\n").filter(Boolean);
    void dropPaths(shell, paths, dest(), e.altKey);
  });
}

export async function dropPaths(shell: Shell, paths: string[], dest: string | "trash", copy: boolean) {
  const vfs = shell.kernel.vfs;
  for (const p of paths) {
    try {
      if (!vfs.exists(u, p)) continue;
      if (dest === "trash") {
        await vfs.trash(u, p);
        continue;
      }
      const parent = p.slice(0, p.lastIndexOf("/")) || "/";
      if (copy) await vfs.copy(u, p, dest);
      else if (parent.toLowerCase() !== dest.toLowerCase()) await vfs.move(u, p, dest);
    } catch (err) {
      const msg = err instanceof KernelError ? explain(err) : String(err);
      await dialog({ html: esc(msg), buttons: [{ id: "ok", label: "OK", primary: true }] });
    }
  }
}
