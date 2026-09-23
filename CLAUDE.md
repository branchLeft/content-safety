# CLAUDE.md — branchLeft content-safety

The safety service for the branchLeft Ghost platform: checks uploaded media against known-abuse hash lists (Arachnid Shield) before publication. It is designed to be reusable by other organisations later, so nothing in here is Ghost-specific.

**This repo is public. Engineer as if public at all times**: no secrets, no tenant-identifying data, no internal-only shorthand, ever — in code, comments, commit messages, or CI logs. Sensitive operational detail (credentials, host specifics, incident detail) belongs in the private `ops-docs` repo, never here.

**No implementation language is chosen yet.** The first story that writes code chooses it, and this file gains the setup, checks and pre-commit sections that decision requires. Do not add language tooling ahead of that choice.

## Design

The design lives in `branchLeft/ghost-platform-docs`, `19-try-it-now-design/07-safety-toolbox.html` (LLD-7, the safety design). Read it before writing the first line of code.

## Comment style

Comments state what the code cannot: a constraint, an invariant, a reason a naive approach fails. They do not narrate what the code does, and they do not record the development process — no ticket IDs, no names, no dated verification logs, no decision history. A work-item reference never appears in shipped source at all, not even a comment.
