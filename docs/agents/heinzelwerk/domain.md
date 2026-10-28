# Domain Docs

How to consume the workspace's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at this repo's root, if it exists, and the workspace glossary **`GLOSSARY.md` in V-M-Pioneer-Trading/meta** (`../meta/GLOSSARY.md`): operator, machine, visitor, scope, game token, account token, center, vault, introspection, `kind`, live fetch, refresh, lane.
- **docs/adr/** in this repo and in meta: ADRs that touch the area you're about to work in.
- Workspace: each repo is one context; meta holds the workspace glossary and workspace-wide ADRs.

## ADRs elsewhere

Numbered decisions that live inside meta's design docs, not in docs/adr/. Read them like ADRs; they are not moved.

- `../meta/docs/design/auth-design.md` "## Decisions" 1–23 (lines 177–1794): auth, scopes, central introspection (21), M2M minting (22), Go→TS (23)
- `../meta/docs/design/autopilot-design.md` "## Decisions" 1–13 (lines 41–141): autopilot; 13 = restart resumes in shadow (owner Q29 = C)

Missing files: proceed silently. They are created lazily by `/heinzelwerk:shape` and tech-lead's docs PR; in team runs, leave candidates in your done note (`term:` / `adr:` lines).

## Use the glossary's vocabulary

Name domain concepts (issue titles, proposals, hypotheses, test names) as `GLOSSARY.md` defines them; never a synonym it marks `_Avoid_`. A concept the glossary lacks is a signal: you're inventing language (reconsider) or there's a gap (`term:` candidate).

## Flag ADR conflicts

Output that contradicts an ADR says so instead of silently overriding: _Contradicts auth-design decision 21 (one verifier), but worth reopening because…_
