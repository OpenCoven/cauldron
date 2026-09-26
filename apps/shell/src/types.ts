import type { KernelEvent } from "@opencoven/cauldron";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => unknown;
}
export interface Menu {
  title: string;
  items: MenuItem[];
}

/** A running app bound to exactly one kernel window. */
export interface AppView {
  readonly windowId: string;
  readonly appId: string;
  readonly el: HTMLElement;
  menus(): Menu[];
  onVfs(e: KernelEvent): void;
  /** Returns false to veto the close (user cancelled). */
  canClose(): Promise<boolean>;
  persist(): Record<string, unknown>;
  onKey?(e: KeyboardEvent): boolean;
  dispose?(): void;
}
