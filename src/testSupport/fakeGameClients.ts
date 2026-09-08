import { GameClients } from "../gameClients";

/**
 * The test adapter for the `GameClients` seam.
 *
 * `GameClients` is the one place this service talks to agent-, fleet- and
 * navigation-service, so it is exactly the seam a test should substitute at.
 * Seven suites instead stood up three real HTTP stub servers each and drove the
 * scheduler through them — which is a seam with one adapter in production and
 * one hand-rolled imitation per test file, rather than a seam with two.
 *
 * Promoted from `__tests__/taskFsm.test.ts`, where this shape was already the
 * fastest and least flaky file in the suite.
 *
 * **Unstubbed calls reject rather than returning undefined.** A test declares
 * the calls it expects; anything else is a loud failure naming the method,
 * instead of a silent `undefined` that surfaces three awaits later as
 * something unrelated.
 */
export const fakeGameClients = (stubs: Partial<GameClients>): GameClients =>
  new Proxy(stubs as GameClients, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop as keyof GameClients];
      return () => Promise.reject(new Error(`unexpected client call: ${prop}`));
    },
  });
