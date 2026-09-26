/** Who is acting. The host (Cave) supplies agent ids; Cauldron keeps no familiar registry. */
export type ActorKind = "user" | "agent" | "system";
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

export const USER: Actor = Object.freeze({ kind: "user", id: "user" });
export const SYSTEM: Actor = Object.freeze({ kind: "system", id: "system" });
export const agent = (id: string): Actor => Object.freeze({ kind: "agent", id });

/** Every kernel operation runs in a context: the acting actor plus the command that caused it. */
export interface Ctx {
  readonly actor: Actor;
  readonly causeId?: string;
}

export const ERROR_CODES = [
  "E_NOTFOUND",
  "E_EXISTS",
  "E_INVALID_NAME",
  "E_CYCLE",
  "E_READONLY",
  "E_QUOTA",
  "E_CONFLICT",
  "E_CONSENT",
  "E_UNKNOWN_OP",
  "E_INVALID_ARGS",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class KernelError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "KernelError";
    this.code = code;
    this.detail = detail;
  }
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ErrorCode; readonly detail?: string };

export const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && a.id === b.id;
