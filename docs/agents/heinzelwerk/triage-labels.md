# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings in the issue tracker named in `issue-tracker.md`, V-M-Pioneer-Trading/meta. The labels exist there, and only there; in a workspace that is the tickets repo, not this one.

| Canonical role | Label in the tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

The "Label in the tracker" column follows the tracker's vocabulary: change it only together with the label in the tracker (`gh label edit <old> --name <new> --repo V-M-Pioneer-Trading/meta`), and change every repo's copy of this table in the workspace with it. Never edit the column to a local preference.
