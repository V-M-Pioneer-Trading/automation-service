import { base } from "@v-m-pioneer-trading/eslint-config";

// .claude/worktrees/ holds agent task worktrees: full checkouts of this repo, linted in their own run.
export default base({ tsconfigRootDir: import.meta.dirname, ignores: [".claude/worktrees/"] });
