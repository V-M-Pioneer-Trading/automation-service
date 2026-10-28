# Contract discovery runs inline before each assignment

The scheduler sees, evaluates and accepts contracts inline, just before it assigns a ship, not in a background job. A background version raced the planner: both acted on the same contract state at once (meta#11). Inline discovery costs a little latency per assignment and keeps one writer.

Source: `README.md#The work loops` (Contracts)
