# Contributing

This is a clean-room project. Read `PROVENANCE.md` first.

1. **Build from the spec only.** The spec is the sole design input. Do not open ryOS or
   Puter source, their deployed DOM/CSS, or their assets — not even to "check something".
2. **If you have read either,** you are on the exclusion list: you may file issues and
   review specs for leaked expression, but not write or review code.
3. **AI tools** run under the same constraint; their sessions must not have those
   repositories in reach.
4. **Assets:** draw your own. No Apple/Microsoft glyphs, traced icons, bitmap-era system
   fonts, or product-named themes.
5. **Every PR** carries the attestation below and a DCO sign-off.

## Attestation

> By opening this pull request I certify, in the sense of the Developer Certificate of
> Origin, that I have the right to submit this work under the project licence. I further
> certify that I have not read, cloned, decompiled, or inspected the source code, deployed
> DOM/CSS, or asset files of ryOS or Puter, and that this contribution was written from the
> Cauldron specification and general knowledge only. If an AI tool assisted, it was
> operated under the same constraint and its session had no access to those repositories.
>
> Signed-off-by: Name <email>

## Tests

Acceptance rows in the spec map 1:1 to test names (`VFS-07 …`). A behavior change without
a named row is not done.
