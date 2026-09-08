import { Clock } from "../clock";

/**
 * The test adapter for the `Clock` seam.
 *
 * This existed as ten separate copies across the suite — nine identical, one
 * missing `advance` — which is what a real seam with only one adapter looks
 * like from the inside: everybody rebuilds the second one locally.
 *
 * Time only moves when a test says so. That is the whole point: the checks and
 * rollups reason about windows, and a clock that advanced on its own would make
 * "did this fire?" depend on how long the assertions took.
 */
export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
