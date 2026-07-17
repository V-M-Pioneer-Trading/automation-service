/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  setupFiles: ["<rootDir>/jest.env.js"],
  // All test files share one real Postgres (no mocked DB layer, per the
  // project's testing decisions). Running files in parallel workers races
  // one file's TRUNCATE against another's inserts, corrupting both.
  maxWorkers: 1,
};
