import type { StorageAdapter, VfsState } from "@opencoven/cauldron";

const VFS_KEY = "cauldron:vfs";

/** P0 shell storage: one JSON document in localStorage. A quota error aborts the mutation (E_QUOTA). */
export class LocalStorageAdapter implements StorageAdapter {
  load(): VfsState | null {
    const raw = localStorage.getItem(VFS_KEY);
    return raw ? (JSON.parse(raw) as VfsState) : null;
  }
  save(state: VfsState): void {
    localStorage.setItem(VFS_KEY, JSON.stringify(state));
  }
}

export const DESKTOP_KEY = "cauldron:desktop";
export const draftKey = (windowId: string) => `cauldron:draft:${windowId}`;
