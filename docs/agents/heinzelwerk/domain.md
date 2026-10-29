# Domain Docs

How to consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or **`GLOSSARY-MAP.md`** if it exists: it points at one `GLOSSARY.md` per context (`src/<context>/GLOSSARY.md`); read each one relevant to the topic. In this workspace: `../meta/GLOSSARY-MAP.md` and `../meta/GLOSSARY.md`.
- **docs/adr/**: ADRs that touch the area you're about to work in; multi-context repos also `src/<context>/docs/adr/`.
- Workspace: each repo is one context; the tickets repo holds `GLOSSARY-MAP.md` (every repo's glossary and how the contexts relate) and workspace-wide ADRs.

## ADRs elsewhere

Numbered decisions that live inside other docs, not in docs/adr/. Read them like ADRs; they are not moved.

- `../meta/docs/design/auth-design.md` "## Decisions" 1–23 (heading :177)
- `../meta/docs/design/autopilot-design.md` "## Decisions" 1–13 (heading :41)

Missing files: proceed silently. They are created lazily by `/heinzelwerk:shape` and tech-lead's docs PR; in team runs, leave candidates in your done note (`term:` / `adr:` lines).

## Use the glossary's vocabulary

Name domain concepts (issue titles, proposals, hypotheses, test names) as `GLOSSARY.md` defines them; never a synonym it marks `_Avoid_`. A concept the glossary lacks is a signal: you're inventing language (reconsider) or there's a gap (`term:` candidate).

## Flag ADR conflicts

Output that contradicts an ADR says so instead of silently overriding: _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
