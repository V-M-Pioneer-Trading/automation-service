export interface ServiceConfig {
  databaseUrl: string;
}

export const configFromEnv = (): ServiceConfig => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL must be set");
  }
  return { databaseUrl };
};
