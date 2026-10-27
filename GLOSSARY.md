# automation-service

The deterministic autopilot: what it decides, how it measures, and what it watches. Workspace-wide terms (scope, M2M token, lane, …) are in `meta/GLOSSARY.md`.

## Language

### Running the fleet

**Autopilot**:
The engine that plans ship tasks and dispatches them. It is **armed** in one of two modes, or disarmed.
_Avoid_: dispatcher, bot

**Shadow**:
Armed mode in which the autopilot decides and records every choice but moves nothing. A restart always resumes in shadow (autopilot-design decision 13).
_Avoid_: dry-run, simulation

**Live**:
Armed mode in which decisions are dispatched to the game.

**Task**:
One ship's resumable state machine (mining, contract, scout), advanced by at most one **phase** per tick.
_Avoid_: job, FSM (as a noun for the task)

**Replan**:
A fresh planner pass over the fleet, triggered by a knob change, an anomaly, a manual request or the interval, under one shared debounce.

### Deciding

**Credits per hour**:
The unit every candidate task is scored in.

**Reserve floor**:
The credit balance the planner never spends below (`credit.reserveFloor`).
_Avoid_: cash floor, credit floor

**Knob**:
A named, bounded tunable. Each belongs to one **class**: `policy` (ai-service may write), `alert` (anomaly thresholds), `model` (planner model values).
_Avoid_: parameter, setting

**Prior**:
A model knob's assumed value, used until enough **observations** exist; **calibration** replaces it with the measured value.

**Verdict**:
How a failed game call is classified: `rejected`, `malformed`, `internal`, `unavailable`, `credentials`, `denied`.

### Watching

**Anomaly**:
A detected trouble condition of a fixed type (`ship_idle`, `earnings_stalled`, `consecutive_failures`, `error_rate`, `market_stale`, `repeated_denied`, `autopilot_resumed_in_shadow`).
_Avoid_: alert (an alert is a knob class)

**Digest**:
The windowed summary of anomalies that ai-service reads.
