import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("reportProgress", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  async function importReportProgress() {
    const mod = await import("../../src/progress.js");
    return mod.reportProgress;
  }

  it("resolves without calling fetch when not in K8s (no KUBERNETES_SERVICE_HOST)", async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.HOSTNAME;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    const reportProgress = await importReportProgress();
    await reportProgress({ currentLoop: 1 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call fetch when data object produces no annotations", async () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.KUBERNETES_SERVICE_PORT = "443";
    process.env.HOSTNAME = "test-pod";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    const reportProgress = await importReportProgress();
    // Empty object — no annotation fields set
    await reportProgress({});

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch with correct URL and annotation keys when in K8s", async () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.KUBERNETES_SERVICE_PORT = "443";
    process.env.HOSTNAME = "my-pod";
    process.env.NAMESPACE = "swarm-ns";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ metadata: {} }), { status: 200 }),
    );

    // Mock fs/promises.readFile for the SA token
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue("fake-sa-token\n"),
    }));

    const reportProgress = await importReportProgress();
    await reportProgress({ currentLoop: 3, confidence: 0.92, phase: "executing" });

    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://10.0.0.1:443/api/v1/namespaces/swarm-ns/pods/my-pod");
    expect(opts.method).toBe("PATCH");
    expect(opts.headers).toMatchObject({
      "Content-Type": "application/merge-patch+json",
      Authorization: "Bearer fake-sa-token",
    });

    const body = JSON.parse(opts.body as string);
    expect(body.metadata.annotations).toMatchObject({
      "swarm.agentswarm.io/current-loop": "3",
      "swarm.agentswarm.io/confidence": "0.92",
      "swarm.agentswarm.io/phase": "executing",
    });
  });
});
