/**
 * @file Typed access to the test-only hooks `createApp` hangs on `app.locals`.
 *
 * `app.locals` is `Record<string, any>`, so calling a hook through it is an
 * unsafe call. These wrappers narrow it once. A hook that is not there (the
 * fleet and metrics hooks exist only when their scheduler does) throws a
 * TypeError naming it, exactly as calling `undefined` did.
 */

import type { Express } from "express";

type HookName = "stopBackgroundSchedulers" | "forceAnomalyTick" | "forceFleetTick" | "forceMetricsTick";

function callHook(app: Express, name: HookName): Promise<void> {
  const hook = (app.locals as Partial<Record<HookName, () => Promise<void>>>)[name];
  if (typeof hook !== "function") throw new TypeError(`app.locals.${name} is not a function`);
  return hook();
}

export const stopBackgroundSchedulers = (app: Express): Promise<void> => callHook(app, "stopBackgroundSchedulers");
export const forceAnomalyTick = (app: Express): Promise<void> => callHook(app, "forceAnomalyTick");
export const forceFleetTick = (app: Express): Promise<void> => callHook(app, "forceFleetTick");
export const forceMetricsTick = (app: Express): Promise<void> => callHook(app, "forceMetricsTick");
