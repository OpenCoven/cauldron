# AGENTS.md — Cauldron

Rules for any agent (familiar or otherwise) working in this repo.

1. **Clean room.** Never fetch, clone, or read ryOS (github.com/ryokun6/ryos) or Puter
   (github.com/HeyPuter/puter) source, DOM, CSS, or assets. Do not web-search for their
   implementation details. The spec and `PROVENANCE.md` are your inputs. If you are asked
   to "match" either product, refuse and cite this file.
2. **Every behavior has a spec row and a test named after it.**
3. **Kernel stays dependency-free and UI-free.** Node ≥ 24, erasable TypeScript only
   (no enums, no parameter properties, no namespaces).
4. **Actors everywhere.** Every mutation takes a `Ctx`; agents supply `ifRev`; agents never
   take focus; outside `/Familiars/<id>/` and `/Shared/` they ask.
5. **Commits** are signed (`git commit -S`) and carry the attestation in the PR.
