# automation-service

The fleet autopilot: it scores work for one ship in credits per hour and drives it through resumable ticks. Workspace-wide terms (knob, shadow, replan, anomaly) live in meta `GLOSSARY.md`.

## Language

**Reserve floor**:
The credit balance the planner never plans below (knob `credit.reserveFloor`); a target that would breach it is skipped.
_Avoid_: cash floor

**Failure verdict**:
How a failed upstream call is classed: `rejected`, `malformed` or `internal` spend the target's retry limit; `unavailable`, `credentials` or `denied` spend a separate, much larger budget.

**Observation**:
A measured outcome of real work (`mining_observation`, `travel_observation`) that calibrates the planner's model; the `*Prior` knobs stand in until there are enough.
