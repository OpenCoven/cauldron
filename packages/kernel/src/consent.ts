import type { EventBus } from "./bus.ts";
import type { Actor } from "./types.ts";

export type ConsentDecision = "granted" | "denied";

export interface ConsentRequest {
  readonly id: string;
  readonly actor: Actor;
  readonly action: string;
  readonly target: string;
  readonly reason?: string;
}

/** Supplied by the host: shows the dialog to the human and resolves with their answer. */
export type ConsentDecider = (request: ConsentRequest) => Promise<ConsentDecision>;

/** With no host attached, nothing is consented to. */
export const denyAll: ConsentDecider = async () => "denied";

/**
 * Kernel-owned consent. Requests are FIFO: the decider sees one at a time,
 * so agents cannot stack dialogs on the human's screen. P0 has no grant
 * store; every qualifying action asks.
 */
export class ConsentBroker {
  #tail: Promise<unknown> = Promise.resolve();
  #bus: EventBus;
  #decide: ConsentDecider;
  #newId: () => string;
  #pending = 0;

  constructor(bus: EventBus, decide: ConsentDecider, newId: () => string) {
    this.#bus = bus;
    this.#decide = decide;
    this.#newId = newId;
  }

  get pending(): number {
    return this.#pending;
  }

  request(input: Omit<ConsentRequest, "id">, causeId?: string): Promise<ConsentDecision> {
    if (input.actor.kind !== "agent") return Promise.resolve("granted");
    const request: ConsentRequest = { ...input, id: this.#newId() };
    this.#pending++;
    this.#bus.emit({ type: "consent:requested", actor: request.actor, causeId, request });
    const run = async (): Promise<ConsentDecision> => {
      let decision: ConsentDecision;
      try {
        decision = (await this.#decide(request)) === "granted" ? "granted" : "denied";
      } catch {
        decision = "denied";
      }
      this.#pending--;
      this.#bus.emit({ type: "consent:resolved", actor: request.actor, causeId, request, decision });
      return decision;
    };
    const result = this.#tail.then(run, run);
    this.#tail = result;
    return result;
  }
}
