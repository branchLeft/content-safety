# CLAUDE.md — branchLeft content-safety

The safety service for the branchLeft Ghost platform: checks uploaded media against known-abuse hash lists (Arachnid Shield) before publication. It is designed to be reusable by other organisations later, so nothing in here is Ghost-specific.

**This repo is public. Engineer as if public at all times**: no secrets, no tenant-identifying data, no internal-only shorthand, ever — in code, comments, commit messages, or CI logs. Sensitive operational detail (credentials, host specifics, incident detail) belongs in the private `ops-docs` repo, never here.

## Design

The design lives in `branchLeft/ghost-platform-docs`, `19-try-it-now-design/07-safety-toolbox.html` (LLD-7, the safety design). Read it before writing the first line of code.

Three rules in it are never traded away here: only hashes leave the estate (`POST /v1/pdq`, never the media or URL endpoints, never the contribution endpoint); only an exact `csam` match is irreversible; and an absent verdict is a hold, never an allow.

## Language and setup

TypeScript on Node (version in `.nvmrc`), ES modules, `tsc` and `vitest`. The tenant descriptor's types come from `@branchleft/ghost-platform-render-core` and the compiler options from `@branchleft/tsconfig`, both on GitHub Packages, so `npm ci` needs a token with `read:packages` (CI uses its own). Neither is redefined here.

## Checks

Run before every push, from the repo root:

```sh
npm run typecheck
npm run build
npm run coverage   # unit tests, 90% threshold on every metric
```

Tests never reach a live service: the hash endpoint is a local stub (`test/helpers/stub-arachnid.ts`) and there is no credential anywhere in this repo.

## Comment style

Comments state what the code cannot: a constraint, an invariant, a reason a naive approach fails. They do not narrate what the code does, and they do not record the development process — no ticket IDs, no names, no dated verification logs, no decision history. A work-item reference never appears in shipped source at all, not even a comment.
