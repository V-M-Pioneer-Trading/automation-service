/** Injectable so tests can control "now" instead of racing the wall clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
