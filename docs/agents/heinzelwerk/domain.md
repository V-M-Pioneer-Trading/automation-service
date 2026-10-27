# Domain Docs

How to consume the domain documentation when exploring this repo. Each repo in the workspace is one context; the tickets repo `meta` holds what spans them. Paths below starting `meta/` are relative to the workspace root (`C:\Users\max\work\spacetraders`).

## Before exploring, read these

- **`meta/GLOSSARY.md`**: workspace-wide vocabulary (operator, machine, scope, game token, the center, introspection, lane, …).
- **`meta/GLOSSARY-MAP.md`**: every repo's own `GLOSSARY.md` and how the contexts relate. Read this repo's `GLOSSARY.md` if it exists, and any other repo's glossary the topic crosses into.
- **ADRs**. The existing decisions are numbered sections, not files: `meta/docs/design/auth-design.md` (decisions 1–23: identity, credentials, the center, Go→TS) and `meta/docs/design/autopilot-design.md` (decisions 1–13: engine, planner, shadow/live, persistence). New workspace-wide ADRs go in `meta/docs/adr/`; ADRs about this repo alone go in its own `docs/adr/`. Read every one that touches the area you're about to work in.

Missing files: proceed silently. They are created lazily by `/heinzelwerk:shape` and tech-lead's docs PR; in team runs, leave candidates in your done note (`term:` / `adr:` lines).

## Use the glossary's vocabulary

Name domain concepts (issue titles, proposals, hypotheses, test names) as the glossaries define them; never a synonym they mark `_Avoid_`. A concept the glossaries lack is a signal: you're inventing language (reconsider) or there's a gap (`term:` candidate).

## Flag ADR conflicts

Output that contradicts a decision says so instead of silently overriding: _Contradicts auth-design decision 21 (one verifier), but worth reopening because…_. The design docs' decisions are settled; reopening one is a proposal to tech-lead, never a silent change.
