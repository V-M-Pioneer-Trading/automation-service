# Issue tracker: GitHub, tickets in meta

Tickets for every repo in this workspace live as GitHub issues in **`V-M-Pioneer-Trading/meta`**, the tickets repo. PRs stay in the repo they change. Use the `gh` CLI for all operations, and pass `--repo V-M-Pioneer-Trading/meta` on every issue command: run from any other repo, `gh` would otherwise target that repo's issues.

## Conventions

- **Create an issue**: `gh issue create --repo V-M-Pioneer-Trading/meta --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo V-M-Pioneer-Trading/meta --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --repo V-M-Pioneer-Trading/meta --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh` here is 2.93, so no `--parent`. Use `gh api --method POST repos/V-M-Pioneer-Trading/meta/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (database id, as in **Blocking** below).
- **Comment on an issue**: `gh issue comment <number> --repo V-M-Pioneer-Trading/meta --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo V-M-Pioneer-Trading/meta --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo V-M-Pioneer-Trading/meta --comment "..."`

## References

Always write a ticket as `V-M-Pioneer-Trading/meta#<n>`, in commits, PR bodies and comments alike. A bare `#<n>` in another repo's PR links to that repo's own issue or PR with the same number.

GitHub shares one number space across issues and PRs, so a bare number may be either: resolve with `gh pr view <n> --repo <repo>` and fall back to `gh issue view <n> --repo <repo>`.

Older issues still open in a service repo (e.g. `V-M-Pioneer-Trading/automation-service#51`) are read where they are; new tickets go to meta.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `V-M-Pioneer-Trading/meta`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Blocking edges

Use GitHub's **native issue dependencies**: `gh api --method POST repos/V-M-Pioneer-Trading/meta/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is `gh api repos/V-M-Pioneer-Trading/meta/issues/<n> --jq .id`. Where dependencies aren't available, put a `Blocked by: V-M-Pioneer-Trading/meta#<n>` line at the top of the body. A ticket is unblocked when every blocker is closed.
