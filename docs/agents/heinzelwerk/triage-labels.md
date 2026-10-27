# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings on tickets in `V-M-Pioneer-Trading/meta` (see `issue-tracker.md`). Labels are applied there only, never on a service repo's issues.

| Canonical role | Label in meta | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Other labels in meta keep their own meaning: `needs-decision` = blocked on an owner decision (Max), `v1.0` = candidate for the unattended-autopilot release.
