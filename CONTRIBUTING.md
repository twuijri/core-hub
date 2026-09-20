# Contributing to Core Hub

Thank you for looking. This repository is owned by twuijri; the rules of work are in
`docs/TEAM-RULES.md` (Arabic) and summarised in `AGENTS.md` (English). Read both before
opening a pull request — they are binding for people and for AI agents alike.

The short version:

1. **Clean room.** Nothing here is copied from Hermes Studio / Ekko Studio or the owner's fork of
   it (`docs/adr/0004-clean-room.md`). Do not consult that source while working here. Ideas from
   other projects go in `docs/inspirations/`; whole files from MIT/Apache projects need an ADR and
   an entry in `THIRD-PARTY-NOTICES.md`.
2. **Contract first.** Add or change the operation or event in `packages/contracts` before the
   server, and the server before the clients (`docs/adr/0003-contract-first.md`).
3. **One task, one branch, one record.** Branch from `main` as `<type>/<topic>`, add
   `docs/changes/YYYY-MM-DD-<owner>-<topic>.md` with the sections from `docs/changes/README.md`,
   and paste the real output of the checks you ran. CI enforces the record.
4. **Checks.** `docs/harness/validation.md` lists what to run for each kind of change;
   `docs/harness/README.md` explains what each check catches. `pnpm install`, then
   `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm contract:test`, `pnpm build`.
5. **Arabic and English.** Every user-facing string exists in both; every screen's entry label
   equals its title (`docs/clients/NAVIGATION.md`).
6. **Pull requests** are written in English: problem, decision, evidence, risks and rollback.
   Only the owner merges into `main`; nobody enables auto-merge. Merging into `main`, publishing
   an image or a release is the owner's decision, never implied by a code request.

Setup: Node 24 (`.nvmrc`), pnpm via `corepack enable`, optional Java 17+ for the Kotlin/Swift
client generators, optional Docker for the image.
