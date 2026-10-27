import { base } from "@v-m-pioneer-trading/eslint-config";

// .claude/worktrees/ holds heinzelwerk task worktrees, each a full checkout of this repo (V-M-Pioneer-Trading/meta#120).
export default base({ tsconfigRootDir: import.meta.dirname, ignores: [".claude/worktrees/"] });
