/** The test database URL. `jest.env.js` always sets it; a missing one is a setup bug, so fail loudly. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("DATABASE_URL is not set (jest.env.js should have set it)");
  return url;
}
