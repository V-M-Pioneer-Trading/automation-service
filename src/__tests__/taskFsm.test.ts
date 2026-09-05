import { Clock } from "../clock";
import { ContractRecord } from "../contractRepo";
import { advanceContractTask } from "../contractTask";
import { GameClients, ShipSnapshot } from "../gameClients";
import { advanceMiningTask } from "../miningTask";
import { advanceScoutTask } from "../scoutTask";
import { ShipTask } from "../shipTaskRepo";
import { refuelIfNeeded, resolveWaitIfElapsed, TaskContext } from "../taskFsm";

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

/** Only the calls a test expects are stubbed; anything else is a loud failure rather than a silent success. */
const clients = (stubs: Partial<GameClients>): GameClients =>
  new Proxy(stubs as GameClients, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop as keyof GameClients];
      return () => Promise.reject(new Error(`unexpected client call: ${prop}`));
    },
  });

const ctx = (overrides: Partial<TaskContext>): TaskContext => ({
  task: task(),
  ship: ship(),
  clients: clients({}),
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
    const result = await refuelIfNeeded(ctx({ ship: ship({ fuel: { current: 60, capacity: 100 } }), clients: clients({ refuel }) }), "mining");
    expect(refuel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ event: "mining_refuel", observations: { refuel: { distance: 40, fuelCredits: 320 } } });
  });

  it("still refuels, just without learning anything, when the response carries no transaction", async () => {
    const refuel = jest.fn().mockResolvedValue({ data: {} });
    const result = await refuelIfNeeded(ctx({ ship: ship({ fuel: { current: 60, capacity: 100 } }), clients: clients({ refuel }) }), "scout");
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
      ...purchaseCtx({ ship: ship({ fuel: { current: 30, capacity: 100 } }), clients: clients({ refuel, purchase }) }),
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
        clients: clients({ purchase }),
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
      clients: clients({
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
        clients: clients({
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
