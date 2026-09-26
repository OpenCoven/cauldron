import type { Actor } from "./types.ts";

/** Every event names the actor that caused it and, when known, the command id. */
export interface KernelEvent {
  readonly type: string;
  readonly actor: Actor;
  readonly causeId?: string;
  readonly [key: string]: unknown;
}

export type Listener = (event: KernelEvent) => void;

export class EventBus {
  #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: KernelEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
