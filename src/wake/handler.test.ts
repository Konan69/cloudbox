import { describe, expect, it, vi } from "vitest";

import { makeWakeHandler, type WakeGcpClient, type WakeRateLimiter } from "./handler.ts";

const request = (secret = "wake-secret", name = "dev") =>
  new Request(`https://wake.example.test/wake/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });

const fakeGcp = (state: string): WakeGcpClient => ({
  getInstanceState: vi.fn(async () => state),
  resumeInstance: vi.fn(async () => undefined),
  startInstance: vi.fn(async () => undefined),
});

const availableLimiter: WakeRateLimiter = { claim: vi.fn(async () => true) };

const handler = (gcp: WakeGcpClient, rateLimiter: WakeRateLimiter = availableLimiter) =>
  makeWakeHandler({
    expectedName: "dev",
    bearerSecret: "wake-secret",
    gcp,
    rateLimiter,
    now: () => 123_000,
  });

describe("wake service request handling with fake GCP and store", () => {
  it("rejects a missing bearer secret before calling GCP", async () => {
    const gcp = fakeGcp("RUNNING");
    const response = await handler(gcp)(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(gcp.getInstanceState).not.toHaveBeenCalled();
  });

  it("returns running without issuing a state change", async () => {
    const gcp = fakeGcp("RUNNING");
    const response = await handler(gcp)(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "running" });
    expect(gcp.resumeInstance).not.toHaveBeenCalled();
    expect(gcp.startInstance).not.toHaveBeenCalled();
  });

  it("resumes a suspended instance", async () => {
    const gcp = fakeGcp("SUSPENDED");
    const response = await handler(gcp)(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: "resuming" });
    expect(gcp.resumeInstance).toHaveBeenCalledWith("dev");
    expect(gcp.startInstance).not.toHaveBeenCalled();
  });

  it("starts a terminated instance", async () => {
    const gcp = fakeGcp("TERMINATED");
    const response = await handler(gcp)(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: "resuming" });
    expect(gcp.startInstance).toHaveBeenCalledWith("dev");
  });

  it("coalesces a second resume inside the 60-second window", async () => {
    const gcp = fakeGcp("SUSPENDED");
    const limiter: WakeRateLimiter = { claim: vi.fn(async () => false) };
    const response = await handler(gcp, limiter)(request());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: "resuming", rateLimited: true });
    expect(gcp.resumeInstance).not.toHaveBeenCalled();
  });
});
