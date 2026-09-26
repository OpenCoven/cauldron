# Cauldron

Kernel for **Covenstead** — the desktop where you can see your familiars work.

A human and her familiars share one desktop. Every window and file says who made it.
When a familiar wants to act outside its own folder, it asks first. The Finder is the
audit trail.

> Status: P0 kernel, unreleased. "Cauldron" is a codename (see `PROVENANCE.md` → Decisions).
> This is a clean-room project — read `PROVENANCE.md` and `CONTRIBUTING.md` before contributing.

## What is here

`@opencoven/cauldron` (`packages/kernel`) — no UI, no dependencies:

| Module | What it does |
|---|---|
| `types.ts` | `Actor {kind: user\|agent\|system, id}`, `Ctx {actor, causeId}`, error codes |
| `bus.ts` | Event bus; every event carries `actor` and `causeId` |
| `consent.ts` | Kernel-owned, FIFO consent broker; host supplies the dialog; fails closed |
| `vfs.ts` | Provenance VFS: `createdBy`/`modifiedBy`/`origin`/`rev`, compare-and-swap (`ifRev`), agent zones (`/Familiars/<id>/`, `/Shared/`), atomic persistence, trash/restore, export/import |
| `wm.ts` | Window manager: owner + status per window, agents open *behind* focus with a badge, cascade, drag/resize clamps, zoom, snapshot/restore |
| `registry.ts` | App manifests and open-with dispatch |
| `commands.ts` | Command bus — the agent API. Idempotency keys, typed errors |
| `kernel.ts` | `createKernel({ storage, decideConsent, viewport })` |

```ts
import { createKernel, agent } from "@opencoven/cauldron";

const k = createKernel({ decideConsent: showDialogToVal });
await k.commands.execute({
  id: crypto.randomUUID(),
  actor: agent("sage"),
  op: "vfs.create",
  args: { path: "/Shared/sources.md", kind: "file", content: "…" },
});
```

## Develop

Requires Node ≥ 24 (runs TypeScript directly; no build step).

```sh
npm test          # node --test, acceptance rows are named by spec ID (VFS-07, WM-09, CMD-01 …)
npm run typecheck # needs a local typescript + @types/node
```

## License

MIT — see `LICENSE`.
