import { base } from "@v-m-pioneer-trading/eslint-config";

// .claude/ holds task worktrees (.claude/worktrees/), each a full checkout with its own config.
export default base({ tsconfigRootDir: import.meta.dirname, ignores: [".claude/"] });
