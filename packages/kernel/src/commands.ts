import { KernelError, type Actor, type Ctx, type Result } from "./types.ts";

export interface Command {
  readonly id: string;
  readonly actor: Actor;
  readonly op: string;
  readonly args?: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

export type Handler = (ctx: Ctx, args: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * The only way apps and host actors mutate state. This is the agent API.
 * Replaying an idempotencyKey (scoped per actor) returns the first result
 * without re-executing.
 */
export class CommandBus {
  #handlers = new Map<string, Handler>();
  #seen = new Map<string, Promise<Result<unknown>>>();

  register(op: string, handler: Handler): void {
    this.#handlers.set(op, handler);
  }

  ops(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  execute<T = unknown>(cmd: Command): Promise<Result<T>> {
    if (!cmd || typeof cmd.id !== "string" || !cmd.actor || typeof cmd.op !== "string") {
      return Promise.resolve({ ok: false, error: "E_INVALID_ARGS", detail: "malformed command" });
    }
    const key = cmd.idempotencyKey ? `${cmd.actor.kind}:${cmd.actor.id}:${cmd.idempotencyKey}` : undefined;
    if (key) {
      const prior = this.#seen.get(key);
      if (prior) return prior as Promise<Result<T>>;
    }
    const result = this.#run(cmd) as Promise<Result<T>>;
    if (key) this.#seen.set(key, result as Promise<Result<unknown>>);
    return result;
  }

  async #run(cmd: Command): Promise<Result<unknown>> {
    const handler = this.#handlers.get(cmd.op);
    if (!handler) return { ok: false, error: "E_UNKNOWN_OP", detail: cmd.op };
    try {
      const value = await handler({ actor: cmd.actor, causeId: cmd.id }, cmd.args ?? {});
      return { ok: true, value };
    } catch (err) {
      if (err instanceof KernelError) {
        return err.detail === undefined ? { ok: false, error: err.code } : { ok: false, error: err.code, detail: err.detail };
      }
      throw err;
    }
  }
}
