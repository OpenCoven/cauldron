import { KernelError } from "./types.ts";

export interface AppManifest {
  id: string;
  name: string;
  singleton: boolean;
  /** mime types, ".ext" extensions, or "*" for "can open anything" */
  opensTypes: string[];
  defaultWindow: { w: number; h: number };
  minWindow: { w: number; h: number };
}

export class AppRegistry {
  #apps = new Map<string, AppManifest>();

  register(manifest: AppManifest): void {
    if (this.#apps.has(manifest.id)) throw new KernelError("E_EXISTS", `app ${manifest.id}`);
    this.#apps.set(manifest.id, structuredClone(manifest));
  }

  get(id: string): AppManifest {
    const app = this.#apps.get(id);
    if (!app) throw new KernelError("E_NOTFOUND", `app ${id}`);
    return structuredClone(app);
  }

  ids(): string[] {
    return [...this.#apps.keys()];
  }

  /** Default app for a file: exact mime or extension match wins over "*". */
  opener(name: string, mime?: string): AppManifest | undefined {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    const apps = [...this.#apps.values()];
    return (
      apps.find((a) => a.opensTypes.some((t) => t === mime || (ext && t.toLowerCase() === ext))) ??
      undefined
    );
  }

  openWith(): AppManifest[] {
    return [...this.#apps.values()].filter((a) => a.opensTypes.includes("*"));
  }
}
