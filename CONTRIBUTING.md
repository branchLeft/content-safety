# Contributing to branchLeft/content-safety

This repo follows the [org-wide contribution guide](https://github.com/branchLeft/.github/blob/main/CONTRIBUTING.md) — fork, branch, PR, squash-merge, one required review. This file covers what's specific to `content-safety`.

## Setup and checks

TypeScript on the Node version in `.nvmrc`. `npm ci` needs a GitHub token with `read:packages` in `NODE_AUTH_TOKEN`, because two dev dependencies are on GitHub Packages. Then:

```sh
npm run typecheck
npm run build
npm run coverage
```

No test may reach a live service or hold a real credential. The hash endpoint is a local stub.

## Comment style

Comments state what the code cannot: a constraint, an invariant, a reason a naive approach fails. They do not narrate what the code does, and they do not record the development process — no ticket IDs, no names, no dated verification logs, no decision history. That belongs in the PR description.
