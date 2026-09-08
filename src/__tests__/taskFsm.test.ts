import { Clock } from "../clock";
import { ContractRecord } from "../contractRepo";
import { advanceContractTask, startContractTask } from "../contractTask";
import { ShipSnapshot } from "../gameClients";
import { advanceMiningTask, startMiningTask } from "../miningTask";
import { advanceScoutTask, startScoutTask } from "../scoutTask";
import { ShipTask } from "../shipTaskRepo";
import { refuelIfNeeded, resolveWaitIfElapsed, TaskContext } from "../taskFsm";
import { fakeGameClients } from "../testSupport/fakeGameClients";

/**
 * The task state machines, driven directly. They take a ship and a task and
 * return the next task, with no database in between, so the edge cases that
 * are awkward to reach through the full HTTP loop can be pinned here in
 * milliseconds.
 */

const NOW = new Date("2026-01-01T00:00:00Z");
const clock: Clock = { now: () => NOW };

const task = (overrides: Partial<ShipTask> = {}): ShipTask => ({
  shipSymbol: "SHIP-1",
  taskKind: "mining",
  phase: "TRAVEL_TO_ASTEROID",
  waitingUntil: null,
  survey: null,
  tradeSymbol: null,
  marketWaypoint: null,
  asteroidWaypoint: "X1-BELT",
  failureCount: 0,
  unrelatedFailureCount: 0,
  contractId: null,
  destinationWaypoint: null,
  unitsDelivered: 0,
  cycleStartedAt: null,
  cycleRevenue: 0,
  cycleTravelDistance: 0,
  cycleUnitsExtracted: 0,
  updatedAt: NOW,
  ...overrides,
});

const ship = (overrides: Partial<ShipSnapshot> = {}): ShipSnapshot => ({
  symbol: "SHIP-1",
  nav: { systemSymbol: "X1", waypointSymbol: "X1-MARKET", status: "DOCKED", route: { arrival: NOW.toISOString() } },
  cooldown: { expiration: null },
  fuel: { current: 100, capacity: 100 },
  cargo: { units: 0, capacity: 10, inventory: [] },
  ...overrides,
});

const ctx = (overrides: Partial<TaskContext>): TaskContext => ({
  task: task(),
  ship: ship(),
  clients: fakeGameClients({}),
  clock,
  ...overrides,
});

const contract: ContractRecord = {
  contractId: "C-1",
  tradeSymbol: "IRON_ORE",
  destinationWaypoint: "X1-DEST",
  unitsRequired: 10,
  totalPayment: 20_000,
  status: "assigned",
  expectedProfit: 15_000,
  cycleHours: 1,
  travelDistance: 30,
  procurementMarket: "X1-MARKET",
};

describe("waits", () => {
  it("does nothing while a wait is pending, and moves to the phase the wait unlocks once it elapses", () => {
    const pending = resolveWaitIfElapsed(ctx({ task: task({ waitingUntil: new Date(NOW.getTime() + 1) }) }), "mining");
    expect(pending).toBeNull();

    const elapsed = resolveWaitIfElapsed(
      ctx({ task: task({ phase: "CONTRACT_TRAVEL_TO_DESTINATION", waitingUntil: NOW }) }),
      "contract"
    );
    expect(elapsed).toMatchObject({ event: "contract_wait_resolved", task: { phase: "CONTRACT_DELIVER", waitingUntil: null } });
  });

  it("re-dispatches the same phase after a cooldown that unlocks nothing new", () => {
    const result = resolveWaitIfElapsed(ctx({ task: task({ phase: "EXTRACT", waitingUntil: NOW }) }), "mining");
    expect(result?.task.phase).toBe("EXTRACT");
  });

  it("is a no-op for a task that isn't waiting", () => {
    expect(resolveWaitIfElapsed(ctx({}), "mining")).toBeUndefined();
  });
});

describe("refuelling", () => {
  it("measures fuel cost from the purchase itself, so no assumption about the tank at cycle start is needed", async () => {
    const refuel = jest.fn().mockResolvedValue({ data: { transaction: { units: 40, totalPrice: 320 } } });
    const result = await refuelIfNeeded(ctx({ ship: ship({ fuel: { current: 60, capacity: 100 } }), clients: fakeGameClients({ refuel }) }), "mining");
    expect(refuel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ event: "mining_refuel", observations: { refuel: { distance: 40, fuelCredits: 320 } } });
  });

  it("still refuels, just without learning anything, when the response carries no transaction", async () => {
    const refuel = jest.fn().mockResolvedValue({ data: {} });
    const result = await refuelIfNeeded(ctx({ ship: ship({ fuel: { current: 60, capacity: 100 } }), clients: fakeGameClients({ refuel }) }), "scout");
    expect(result?.event).toBe("scout_refuel");
    expect(result?.observations).toBeUndefined();
  });

  it("is skipped on a full tank", async () => {
    expect(await refuelIfNeeded(ctx({}), "mining")).toBeNull();
  });
});

describe("contract purchase", () => {
  const purchaseCtx = (overrides: Partial<TaskContext>) =>
    ctx({ task: task({ taskKind: "contract", phase: "CONTRACT_PURCHASE", contractId: "C-1", asteroidWaypoint: null }), ...overrides });

  it("tops the tank up at the procurement market before buying, so the delivery leg can't strand the ship", async () => {
    const refuel = jest.fn().mockResolvedValue({ data: {} });
    const purchase = jest.fn();
    const result = await advanceContractTask({
      ...purchaseCtx({ ship: ship({ fuel: { current: 30, capacity: 100 } }), clients: fakeGameClients({ refuel, purchase }) }),
      contract,
    });
    expect(result?.event).toBe("contract_refuel");
    expect(purchase).not.toHaveBeenCalled();
  });

  it("buys only what the hold has room for, counting only the contract's own good toward what's owed", async () => {
    const purchase = jest.fn().mockResolvedValue({ data: { transaction: { totalPrice: 500 } } });
    // 10 owed, 2 already held, 3 units of something unrelated taking up room:
    // 8 still owed, 5 units of room. Pre-fix the unrelated cargo was assumed
    // to be contract goods, so the ship bought 5 and thought it owed 5 fewer.
    const result = await advanceContractTask({
      ...purchaseCtx({
        ship: ship({
          cargo: { units: 5, capacity: 10, inventory: [{ symbol: "IRON_ORE", units: 2 }, { symbol: "OTHER", units: 3 }] },
        }),
        clients: fakeGameClients({ purchase }),
      }),
      contract,
    });
    expect(purchase).toHaveBeenCalledWith("SHIP-1", "IRON_ORE", 5);
    expect(result).toMatchObject({ event: "contract_purchase", task: { phase: "CONTRACT_TRAVEL_TO_DESTINATION" } });
  });

  it("skips the purchase when the hold already carries everything owed", async () => {
    const result = await advanceContractTask({
      ...purchaseCtx({ ship: ship({ cargo: { units: 10, capacity: 10, inventory: [{ symbol: "IRON_ORE", units: 10 }] } }) }),
      contract,
    });
    expect(result).toMatchObject({ event: "contract_purchase_skipped", task: { phase: "CONTRACT_TRAVEL_TO_DESTINATION" } });
  });
});

describe("scout refresh", () => {
  it("refuels at the market, then reads it in person and hands the ship back idle with the refresh on record", async () => {
    const scoutCtx = ctx({
      task: task({ taskKind: "scout", phase: "SCOUT_REFRESH", asteroidWaypoint: "X1-MARKET" }),
      ship: ship({ fuel: { current: 50, capacity: 100 } }),
      clients: fakeGameClients({
        refuel: jest.fn().mockResolvedValue({ data: {} }),
        getMarket: jest.fn().mockResolvedValue({ symbol: "X1-MARKET", tradeGoods: [{ symbol: "FUEL", sellPrice: 1, purchasePrice: 2 }] }),
      }),
    });
    const refuel = await advanceScoutTask(scoutCtx);
    expect(refuel?.event).toBe("scout_refuel");

    const refresh = await advanceScoutTask({ ...scoutCtx, ship: ship() });
    expect(refresh).toMatchObject({
      event: "scout_market_refresh",
      observations: { marketsRefreshed: ["X1-MARKET"] },
      task: { taskKind: "mining", asteroidWaypoint: null, contractId: null },
    });
  });
});

describe("mining", () => {
  it("refuses to advance a task whose phase belongs to another kind, so the failure is counted instead of silently stalling", async () => {
    await expect(advanceMiningTask(ctx({ task: task({ phase: "SCOUT_TRAVEL" }) }))).rejects.toThrow(/cannot advance/);
  });

  it("records the market it read while docked as refreshed, alongside the sell", async () => {
    const sell = jest.fn().mockResolvedValue({ data: { transaction: { totalPrice: 90 } } });
    const result = await advanceMiningTask(
      ctx({
        task: task({ phase: "SELL", marketWaypoint: "X1-MARKET", tradeSymbol: "IRON_ORE" }),
        ship: ship({ cargo: { units: 3, capacity: 10, inventory: [{ symbol: "IRON_ORE", units: 3 }] } }),
        clients: fakeGameClients({
          getMarket: jest.fn().mockResolvedValue({ symbol: "X1-MARKET", tradeGoods: [{ symbol: "IRON_ORE", sellPrice: 30, purchasePrice: 40 }] }),
          sell,
        }),
      })
    );
    expect(sell).toHaveBeenCalledWith("SHIP-1", "IRON_ORE", 3);
    expect(result).toMatchObject({
      event: "mining_sell",
      task: { cycleRevenue: 90 },
      observations: { marketsRefreshed: ["X1-MARKET"] },
    });
  });
});

/**
 * How a task of each kind *begins*, pinned beside how it proceeds.
 *
 * These shapes used to be written inline in `FleetScheduler.assignTarget`, so
 * the scheduler was the author of column meanings the FSMs interpret —
 * `tradeSymbol` is the deliverable for a contract and the extracted good for
 * mining, `asteroidWaypoint` is a market for a scout. What each kind means is
 * now decided in one module per kind, and asserted here.
 */
describe("how each task kind starts", () => {
  // A finished cycle's leftovers: whatever a new assignment is built on top of
  // has to clear these, or the observation written at the end of the next cycle
  // counts the previous one's takings (see idleTask).
  const finished = task({
    taskKind: "contract",
    phase: "CONTRACT_FULFILL",
    tradeSymbol: "COPPER_ORE",
    marketWaypoint: "X1-OLD-MARKET",
    contractId: "C-OLD",
    destinationWaypoint: "X1-OLD-DEST",
    unitsDelivered: 7,
    failureCount: 3,
    unrelatedFailureCount: 9,
    cycleRevenue: 5000,
    cycleTravelDistance: 40,
    cycleUnitsExtracted: 12,
    cycleStartedAt: new Date("2025-12-31T00:00:00Z"),
    survey: { signature: "SIG", symbol: "X1-OLD", deposits: [], expiration: "", size: "MODERATE" },
  });

  /**
   * Every column, not a subset. `toMatchObject` ignores extras, which is how a
   * `waitingUntil` or a stray `marketWaypoint` on a fresh assignment slips
   * through — a task that starts already waiting never dispatches anything.
   */
  const opening = (overrides: Partial<ShipTask>): ShipTask => ({
    shipSymbol: finished.shipSymbol,
    taskKind: "mining",
    phase: "TRAVEL_TO_ASTEROID",
    waitingUntil: null,
    survey: null,
    tradeSymbol: null,
    marketWaypoint: null,
    asteroidWaypoint: null,
    failureCount: 0,
    unrelatedFailureCount: 0,
    contractId: null,
    destinationWaypoint: null,
    unitsDelivered: 0,
    cycleStartedAt: null,
    cycleRevenue: 0,
    cycleTravelDistance: 0,
    cycleUnitsExtracted: 0,
    updatedAt: finished.updatedAt,
    ...overrides,
  });

  it("mining: the field to work, and nothing carried over", () => {
    // tradeSymbol cleared: for mining it is what the ship has extracted, and it
    // has extracted nothing yet - which is also what makes it usable as
    // "is cargo at stake?".
    expect(startMiningTask(finished, "X1-BELT")).toEqual(opening({ asteroidWaypoint: "X1-BELT" }));
  });

  it("scout: the market to refresh, in the column every kind uses for its target", () => {
    expect(startScoutTask(finished, "X1-MARKET-2")).toEqual(
      opening({ taskKind: "scout", phase: "SCOUT_TRAVEL", asteroidWaypoint: "X1-MARKET-2" })
    );
  });

  it("contract: four columns meaning something other than they do for mining", () => {
    expect(startContractTask(finished, contract)).toEqual(
      opening({
        taskKind: "contract",
        phase: "CONTRACT_TRAVEL_TO_MARKET",
        // The deliverable, set before anything is bought (meta#27) - which is
        // why contractCargoAtStake reads the phase and not this.
        tradeSymbol: "IRON_ORE",
        // Where to buy, not where to sell.
        marketWaypoint: "X1-MARKET",
        destinationWaypoint: "X1-DEST",
        contractId: "C-1",
      })
    );
  });
});
