# Issue tracker: GitHub

Issues and specs live as GitHub issues in **V-M-Pioneer-Trading/meta** (owner/repo). Use the `gh` CLI for all operations, and name the tracker on every command: `--repo V-M-Pioneer-Trading/meta` on `gh issue` commands, `repos/V-M-Pioneer-Trading/meta/…` in the path of `gh api` calls (`gh api` takes no `--repo`). `gh` otherwise infers the repo from the current clone, which from a sibling repo or a task worktree is the wrong one.

## Conventions

- **Create an issue**: `gh issue create --repo V-M-Pioneer-Trading/meta --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo V-M-Pioneer-Trading/meta --json number,title,body,labels,comments,blockedBy` (`blockedBy` needs `gh` 2.94+). Older `gh`, or `blockedBy.totalCount` larger than the nodes returned (the list is cut): drop the field and fetch every blocker with `gh api --paginate repos/V-M-Pioneer-Trading/meta/issues/<number>/dependencies/blocked_by`. The body's `Blocked by:` line counts only where native dependencies aren't used (**Blocking edges** below).
- **List issues**: `gh issue list --repo V-M-Pioneer-Trading/meta --state open --limit 500 --json number,title,body,labels --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'` with appropriate `--label` and `--state` (`open`, `closed`, `all`) filters. The default limit is 30 and the JSON does not say it was cut. Comments are left out on purpose: `gh` returns at most 100 per issue without saying so; read an issue's comments with `gh api --paginate repos/V-M-Pioneer-Trading/meta/issues/<number>/comments`. A tracker with more than 500 matching issues pages with `gh api --paginate 'repos/V-M-Pioneer-Trading/meta/issues?state=<open|closed|all>&labels=<a,b>&per_page=100' --jq '.[] | select(.pull_request | not) | {number, title, body, labels: [.labels[].name]}'` (drop `&labels=` for no label filter): the REST list includes pull requests (the filter drops them) and prints one object per line rather than an array.
- **Make an issue a sub-issue of a parent** (`gh` 2.94+): `gh issue create --repo V-M-Pioneer-Trading/meta --parent <parent> ...`, or `gh issue edit <parent> --repo V-M-Pioneer-Trading/meta --add-sub-issue <child>` afterwards. Older `gh`: `gh api --method POST repos/V-M-Pioneer-Trading/meta/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below). Without sub-issues, put `Part of V-M-Pioneer-Trading/meta#<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --repo V-M-Pioneer-Trading/meta --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo V-M-Pioneer-Trading/meta --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo V-M-Pioneer-Trading/meta --comment "..."`

## Workspace

Tickets live in one repo for the whole workspace: **V-M-Pioneer-Trading/meta**. Every command above targets it, from whichever repo you are in. References are always `owner/repo#N` (`Refs`, `Closes`, `Blocked by`, `Part of`, commit messages), never a bare `#N`: the number space differs per repo.

A bare `#42` met in prose is ambiguous: a ticket is `gh issue view 42 --repo V-M-Pioneer-Trading/meta`; a pull request is `gh pr view 42 --repo <owner/repo of that PR>` (the PR's own repo, which is only the current one when the text says so). Never resolve a bare number against the current clone and take the first hit.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in **V-M-Pioneer-Trading/meta**.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above, blockers included.

## Blocking edges

Use GitHub's **native issue dependencies**: `gh issue edit <child> --repo V-M-Pioneer-Trading/meta --add-blocked-by <blocker>`, or `--blocked-by <blocker>` on `gh issue create` (`gh` 2.94+). Older `gh`: `gh api --method POST repos/V-M-Pioneer-Trading/meta/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is `gh api repos/V-M-Pioneer-Trading/meta/issues/<n> --jq .id`. Where dependencies aren't available, put a `Blocked by: V-M-Pioneer-Trading/meta#<n>, V-M-Pioneer-Trading/meta#<n>` line at the top of the body. A ticket is unblocked when every blocker is closed.
