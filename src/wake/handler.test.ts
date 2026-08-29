import { describe, expect, it, vi } from "vitest";

import { makeWakeHandler, type WakeGcpClient, type WakeRateLimiter } from "./handler.ts";

const allowedOrigin = "https://app.example.test";

interface RequestOptions {
  readonly route?: "wake" | "status";
  readonly method?: string;
  readonly secret?: string;
  readonly name?: string;
  readonly origin?: string;
}

const request = ({
  route = "wake",
  method = route === "wake" ? "POST" : "GET",
  secret = "wake-secret",
  name = "dev",
  origin,
}: RequestOptions = {}) => {
  const headers = new Headers();
  if (secret.length > 0) headers.set("Authorization", `Bearer ${secret}`);
  if (origin !== undefined) headers.set("Origin", origin);
  return new Request(`https://wake.example.test/${route}/${name}`, { method, headers });
};

const fakeGcp = (state: string): WakeGcpClient => ({
  getInstanceState: vi.fn(async () => state),
  resumeInstance: vi.fn(async () => undefined),
  startInstance: vi.fn(async () => undefined),
});

const handler = (
  gcp: WakeGcpClient,
  rateLimiter: WakeRateLimiter = { claim: vi.fn(async () => true) },
) =>
  makeWakeHandler({
    expectedName: "dev",
    bearerSecret: "wake-secret",
    allowedOrigins: [allowedOrigin],
    gcp,
    rateLimiter,
    now: () => 123_000,
  });

describe("wake service request handling with fake GCP and store", () => {
  it("rejects a missing bearer secret before calling GCP", async () => {
    const gcp = fakeGcp("RUNNING");
    const response = await handler(gcp)(request({ secret: "wrong-secret" }));

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

describe("GET /status/<name>", () => {
  it.each([
    ["SUSPENDED", "suspended"],
    ["RUNNING", "running"],
    ["RESUMING", "resuming"],
    ["PROVISIONING", "resuming"],
    ["STAGING", "resuming"],
    ["SUSPENDING", "other"],
    ["TERMINATED", "stopped"],
    ["STOPPING", "stopped"],
    ["REPAIRING", "other"],
  ] as const)("maps GCE %s to %s without mutating state or rate data", async (gceStatus, state) => {
    const gcp = fakeGcp(gceStatus);
    const limiter: WakeRateLimiter = { claim: vi.fn(async () => true) };
    const response = await handler(gcp, limiter)(request({ route: "status" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ state, gceStatus, name: "dev" });
    expect(gcp.resumeInstance).not.toHaveBeenCalled();
    expect(gcp.startInstance).not.toHaveBeenCalled();
    expect(limiter.claim).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer before reading GCE", async () => {
    const gcp = fakeGcp("SUSPENDED");
    const response = await handler(gcp)(
      request({ route: "status", secret: "wrong-secret" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(gcp.getInstanceState).not.toHaveBeenCalled();
  });

  it("rejects an unexpected instance name before reading GCE", async () => {
    const gcp = fakeGcp("SUSPENDED");
    const response = await handler(gcp)(request({ route: "status", name: "other" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(gcp.getInstanceState).not.toHaveBeenCalled();
  });

  it.each([
    ["wake", "GET", "POST, OPTIONS"],
    ["status", "POST", "GET, OPTIONS"],
  ] as const)("rejects %s requests using %s", async (route, method, allow) => {
    const gcp = fakeGcp("RUNNING");
    const response = await handler(gcp)(request({ route, method }));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
    expect(gcp.getInstanceState).not.toHaveBeenCalled();
  });
});

describe("wake service CORS", () => {
  it("echoes an allowed origin on an authenticated response", async () => {
    const response = await handler(fakeGcp("RUNNING"))(
      request({ route: "status", origin: allowedOrigin }),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowedOrigin);
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("does not return access-control headers to a denied origin", async () => {
    const response = await handler(fakeGcp("RUNNING"))(
      request({ route: "status", origin: "https://denied.example.test" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it.each(["wake", "status"] as const)("handles an allowed %s preflight without auth", async (route) => {
    const gcp = fakeGcp("RUNNING");
    const response = await handler(gcp)(
      request({ route, method: "OPTIONS", secret: "", origin: allowedOrigin }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowedOrigin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "authorization, content-type",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(gcp.getInstanceState).not.toHaveBeenCalled();
  });

  it("returns a bare preflight to a denied origin", async () => {
    const response = await handler(fakeGcp("RUNNING"))(
      request({
        route: "status",
        method: "OPTIONS",
        secret: "",
        origin: "https://denied.example.test",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });
});
