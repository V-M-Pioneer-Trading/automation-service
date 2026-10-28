# Every scoring input is logged so decisions replay offline

The planner writes every input of every scoring decision to the event log, so `npm run replay` can re-score past decisions offline with changed knobs. This fixes what the event log must carry: a scoring input that is not logged cannot be replayed, and dropping fields to save space breaks replay of everything after.

Source: V-M-Pioneer-Trading/meta `docs/algorithms.md#Shadow mode and replay`
