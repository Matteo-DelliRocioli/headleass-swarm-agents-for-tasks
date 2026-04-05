import { describe, it, expect, beforeEach } from "vitest";
import { Reconciler } from "../src/reconciler";
import { ConcurrencyController } from "../src/concurrency";
import {
  makeConfig,
  makeMockCoreApi,
  makeMockCustomApi,
  makeMockBeadsQueue,
  makeMockStatusUpdater,
  makeSwarmRun,
  silentLogger,
} from "./helpers";

describe("Reconciler — queue drain", () => {
  const config = makeConfig({ maxConcurrentRuns: 5 });

  let coreApi: ReturnType<typeof makeMockCoreApi>;
  let customApi: ReturnType<typeof makeMockCustomApi>;
  let beadsQueue: ReturnType<typeof makeMockBeadsQueue>;
  let statusUpdater: ReturnType<typeof makeMockStatusUpdater>;
  let concurrency: ConcurrencyController;
  let reconciler: Reconciler;

  function setup(activePods: string[], queuedRuns: ReturnType<typeof makeSwarmRun>[]) {
    coreApi = makeMockCoreApi(activePods);
    customApi = makeMockCustomApi(queuedRuns);
    beadsQueue = makeMockBeadsQueue();
    statusUpdater = makeMockStatusUpdater();
    concurrency = new ConcurrencyController(coreApi as any, beadsQueue as any, config);
    reconciler = new Reconciler(
      coreApi as any,
      customApi as any,
      beadsQueue as any,
      concurrency,
      statusUpdater as any,
      config,
      silentLogger as any,
    );
  }

  describe("drainQueue", () => {
    it("starts queued runs when slots are available", async () => {
      // 3 active pods, 2 free slots
      const queued = [
        makeSwarmRun("run-6", "Queued"),
        makeSwarmRun("run-7", "Queued"),
      ];
      setup(["p1", "p2", "p3"], queued);

      await reconciler.drainQueue();

      // Both should have been started (phase → Running)
      const updates = statusUpdater.getUpdates();
      const runningUpdates = updates.filter((u) => u.phase === "Running");
      expect(runningUpdates.length).toBe(2);
    });

    it("stops draining when max slots reached", async () => {
      // 4 active pods, only 1 free slot — only first queued run should start
      const queued = [
        makeSwarmRun("run-6", "Queued", { spec: { priority: 1 } as any }),
        makeSwarmRun("run-7", "Queued", { spec: { priority: 2 } as any }),
        makeSwarmRun("run-8", "Queued", { spec: { priority: 3 } as any }),
      ];
      setup(["p1", "p2", "p3", "p4"], queued);

      await reconciler.drainQueue();

      // Only 1 slot was free
      const updates = statusUpdater.getUpdates();
      const runningUpdates = updates.filter((u) => u.phase === "Running");
      expect(runningUpdates.length).toBe(1);
      expect(runningUpdates[0].name).toBe("run-6"); // Highest priority (P1) goes first
    });

    it("does nothing when all slots are full", async () => {
      const queued = [makeSwarmRun("run-6", "Queued")];
      setup(["p1", "p2", "p3", "p4", "p5"], queued);

      await reconciler.drainQueue();

      const updates = statusUpdater.getUpdates();
      expect(updates.filter((u) => u.phase === "Running").length).toBe(0);
    });

    it("sorts queued runs by priority (lower number = higher priority)", async () => {
      const queued = [
        makeSwarmRun("low-priority", "Queued", { spec: { priority: 4 } as any }),
        makeSwarmRun("high-priority", "Queued", { spec: { priority: 0 } as any }),
        makeSwarmRun("medium-priority", "Queued", { spec: { priority: 2 } as any }),
      ];
      setup([], queued); // No active pods, 5 free slots

      await reconciler.drainQueue();

      const updates = statusUpdater.getUpdates();
      const runningUpdates = updates.filter((u) => u.phase === "Running");
      // All 3 should start, but high-priority first
      expect(runningUpdates.length).toBe(3);
      expect(runningUpdates[0].name).toBe("high-priority");
      expect(runningUpdates[1].name).toBe("medium-priority");
      expect(runningUpdates[2].name).toBe("low-priority");
    });
  });

  describe("6 runs submitted, max 5", () => {
    it("scenario: 6 queued runs, drainQueue starts exactly 5", async () => {
      // 6 runs already in Queued state, 0 active pods → drainQueue should start 5
      const queued = Array.from({ length: 6 }, (_, i) =>
        makeSwarmRun(`run-${i + 1}`, "Queued"),
      );
      setup([], queued);

      await reconciler.drainQueue();

      const updates = statusUpdater.getUpdates();
      const runningUpdates = updates.filter((u) => u.phase === "Running");

      // Exactly 5 should start (mock pods grow as createNamespacedPod is called)
      expect(runningUpdates.length).toBe(5);

      // The 6th should NOT have started
      const startedNames = new Set(runningUpdates.map((u) => u.name));
      const notStarted = queued.filter((r) => !startedNames.has(r.metadata.name));
      expect(notStarted.length).toBe(1);
    });

    it("scenario: after one completes, 6th starts", async () => {
      // 5 active pods, 1 queued run
      const queued = [makeSwarmRun("run-6", "Queued")];
      setup(["p1", "p2", "p3", "p4", "p5"], queued);

      // No slot → nothing starts
      await reconciler.drainQueue();
      expect(statusUpdater.getUpdates().filter((u) => u.phase === "Running").length).toBe(0);

      // Simulate one pod completing (remove from pod list)
      coreApi._pods.splice(0, 1); // Remove p1

      // Now drain again → should start run-6
      await reconciler.drainQueue();
      const updates = statusUpdater.getUpdates();
      const runningUpdates = updates.filter((u) => u.phase === "Running");
      expect(runningUpdates.length).toBe(1);
      expect(runningUpdates[0].name).toBe("run-6");
    });
  });
});
