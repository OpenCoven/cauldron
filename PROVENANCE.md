# PROVENANCE

Cauldron is a clean-room implementation. This file is the record of what went in,
who saw what, and how independence is checked. Template from Sage's clean-room brief
(Coven handoff `2026-09-25-cauldron-cleanroom-brief.md`). Research, not legal advice.

## Inputs consulted
| Input | URL | Revision / date read | Who | What was observed |
|---|---|---|---|---|
| ryOS README (top level only), via a summarizing fetch | https://github.com/ryokun6/ryos | 2026-09-25; repo HEAD was `56c26f1c` (committed 2026-09-25T20:06Z) when recorded — the README fetch was earlier that day, so the exact revision read may be older | Cody | Feature list, app list, theme names, stack, license (AGPL-3.0). No source, DOM, CSS, or assets. |
| ryOS README (top level only) | https://github.com/ryokun6/ryos | 2026-09-25 | Sage (review) | Same, for the spec review. |
| Behavioral spec v0.2 | Coven handoff `2026-09-25-cleanroom-desktop-p0-spec.md` | 2026-09-25 | Cody (author), implementers | The only input to implementation. |
| Prior-art scan (AIOS, computer-use demo, E2B, Puter README, AgentRoom, YoloFS abstracts) | see review file `2026-09-25-cleanroom-desktop-p0-review.md` | 2026-09-25 | Sage | Concept-level only. Puter: README only. |

## Exclusion list (may not implement or review code)
- ryOS: https://github.com/ryokun6/ryos (AGPL-3.0) — source, deployed DOM/CSS, assets
- Puter: https://github.com/HeyPuter/puter (AGPL-3.0) — source, deployed DOM/CSS, assets
- Anyone who has read either, in any form, since 2026-09-25: none known.

## Known weakness, stated plainly
The specifier and the first implementer are the same familiar (Cody), and it runs on a
language model that may have ryOS in its training data. The defence therefore rests on
this record, a human second read of the spec, and a similarity check at release — not
on anyone's claimed innocence.

## Reviews
| Date | Reviewer | Artifact | Findings | Resolution |
|---|---|---|---|---|
| 2026-09-25 | Sage, Nova (familiar persona reviews) | Spec v0.1 | Agent-readiness gaps; one-person clean room risk | Spec v0.2; this file |
| 2026-09-25 | Val Alexander (human second read) | Spec v0.2 | Read in full; no leaked expression reported | Approved publication |

## Similarity checks
| Release | Tool | Target revision | Operator (excluded person) | Report path | Result |
|---|---|---|---|---|---|
| — | JPlag or equivalent | ryOS at release date | an excluded person on a separate machine | pending | pending |

## Decisions
| Date | Decision | By |
|---|---|---|
| 2026-09-25 | License MIT | Val (delegated to Cody) |
| 2026-09-25 | Ship as a Coven Cave surface; kernel standalone | Val (delegated to Cody) |
| 2026-09-25 | Provenance + consent in P0 | Val (delegated to Cody) |
| 2026-09-25 | "Cauldron" = kernel codename; "Covenstead" = proposed surface name (Charm). Release name only after a USPTO/EUIPO search — "Cauldron" is crowded (AMD GPUOpen, Deque's React library, a 2024 US filing) | Val (delegated to Cody) |
| 2026-09-25 | Theme "Slate", original glyphs, left-hand title-bar controls; no Apple/Microsoft product names for themes | Val (delegated to Cody) |
| 2026-09-25 | Repository made public; ruleset `main` (signed commits, required `unit + e2e`, no force-push/deletion) applied | Val |

## Open items
- Future README reads: pin a commit URL (`/blob/<sha>/README.md`) so the revision is exact. HEAD SHA above was read via `gh api …/commits/HEAD` (metadata only, no file contents).
- Pick and log a UI typeface (OFL) before any theme work.
