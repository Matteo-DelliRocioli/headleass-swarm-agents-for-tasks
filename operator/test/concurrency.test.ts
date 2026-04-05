import { describe, it, expect } from "vitest";
import { ConcurrencyController } from "../src/concurrency";
import { makeConfig, makeMockCoreApi, makeMockBeadsQueue } from "./helpers";

describe("ConcurrencyController", () => {
  const config = makeConfig({ maxConcurrentRuns: 5 });

  describe("tryAcquireSlot", () => {
    it("returns true when no active pods or beads", async () => {
      const coreApi = makeMockCoreApi([]);
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(true);
    });

    it("returns true when below max (4 of 5)", async () => {
      const coreApi = makeMockCoreApi(["pod-1", "pod-2", "pod-3", "pod-4"]);
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(true);
    });

    it("returns false when at max (5 of 5)", async () => {
      const coreApi = makeMockCoreApi(["pod-1", "pod-2", "pod-3", "pod-4", "pod-5"]);
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(false);
    });

    it("returns false when over max (6 pods — race condition recovery)", async () => {
      const coreApi = makeMockCoreApi(["p1", "p2", "p3", "p4", "p5", "p6"]);
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(false);
    });

    it("uses max(pods, beads) as effective count", async () => {
      // 3 pods but 5 beads in progress — effective is 5 (blocked)
      const coreApi = makeMockCoreApi(["pod-1", "pod-2", "pod-3"]);
      const beadsQueue = makeMockBeadsQueue();
      beadsQueue.setInProgressCount(5);
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(false);
    });

    it("uses max(pods, beads) — pods higher", async () => {
      // 5 pods but only 2 beads in progress — effective is 5 (blocked)
      const coreApi = makeMockCoreApi(["p1", "p2", "p3", "p4", "p5"]);
      const beadsQueue = makeMockBeadsQueue();
      beadsQueue.setInProgressCount(2);
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      expect(await controller.tryAcquireSlot()).toBe(false);
    });

    it("respects maxConcurrentRuns=1 (single slot)", async () => {
      const singleConfig = makeConfig({ maxConcurrentRuns: 1 });
      const coreApi = makeMockCoreApi(["pod-1"]);
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, singleConfig);

      expect(await controller.tryAcquireSlot()).toBe(false);
    });

    it("excludes Succeeded/Failed pods from count", async () => {
      const coreApi = makeMockCoreApi([]);
      // Override with 5 pods: 3 Running, 1 Succeeded, 1 Failed
      coreApi.listNamespacedPod = async () => ({
        items: [
          { metadata: { name: "p1" }, status: { phase: "Running" } },
          { metadata: { name: "p2" }, status: { phase: "Running" } },
          { metadata: { name: "p3" }, status: { phase: "Running" } },
          { metadata: { name: "p4" }, status: { phase: "Succeeded" } },
          { metadata: { name: "p5" }, status: { phase: "Failed" } },
        ],
      });
      const beadsQueue = makeMockBeadsQueue();
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      // Only 3 active, should have a slot
      expect(await controller.tryAcquireSlot()).toBe(true);

      const counts = await controller.getActiveCount();
      expect(counts.pods).toBe(3);
    });
  });

  describe("getActiveCount", () => {
    it("returns correct breakdown", async () => {
      const coreApi = makeMockCoreApi(["p1", "p2"]);
      const beadsQueue = makeMockBeadsQueue();
      beadsQueue.setInProgressCount(3);
      const controller = new ConcurrencyController(coreApi as any, beadsQueue as any, config);

      const counts = await controller.getActiveCount();
      expect(counts.pods).toBe(2);
      expect(counts.beads).toBe(3);
      expect(counts.effective).toBe(3); // max(2, 3)
    });
  });
});
