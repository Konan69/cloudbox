import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  GcpApi,
  GcpApiError,
  isApiPropagationError,
  isTransientNetworkCause,
} from "./client.ts";

describe("GcpApi operation polling", () => {
  it.effect("polls Google long-running operations on the product API", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const fakeFetch: typeof fetch = async (input) => {
        requests.push(String(input));
        return Response.json({ name: "projects/p/locations/europe-west2/operations/op-1", done: true });
      };
      const api = new GcpApi({
        project: "cloudbox-project",
        tokenProvider: async () => "test-token",
        fetch: fakeFetch,
        pollIntervalMs: 0,
      });

      const operation = yield* api.waitForGoogleOperation(
        { name: "projects/p/locations/europe-west2/operations/op-1" },
        "https://run.googleapis.com/v2",
      );

      expect(operation.done).toBe(true);
      expect(requests).toEqual([
        "https://run.googleapis.com/v2/projects/p/locations/europe-west2/operations/op-1",
      ]);
    }),
  );

  it.effect("uses zonal operations.wait until the operation is DONE", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
      const responses = [
        { name: "operation-1", status: "PENDING" },
        { name: "operation-1", status: "DONE" },
      ];
      const fakeFetch: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init });
        const response = responses.shift();
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      const api = new GcpApi({
        project: "cloudbox-project",
        tokenProvider: async () => "test-token",
        fetch: fakeFetch,
        pollIntervalMs: 0,
        maxOperationPolls: 3,
      });

      const operation = yield* api.waitForOperation(
        { name: "operation-1", status: "PENDING" },
        { zone: "us-central1-a" },
      );

      expect(operation.status).toBe("DONE");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe(
        "https://compute.googleapis.com/compute/v1/projects/cloudbox-project/zones/us-central1-a/operations/operation-1/wait",
      );
      expect(requests[0]?.init?.method).toBe("POST");
      expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
        "Bearer test-token",
      );
    }),
  );
});

describe("GcpApi retry classification", () => {
  it("classifies only known transient network failures", () => {
    expect(isTransientNetworkCause({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientNetworkCause({ message: "fetch failed", cause: { code: "ETIMEDOUT" } })).toBe(true);
    expect(isTransientNetworkCause(new Error("invalid request"))).toBe(false);
  });

  it("classifies API activation propagation without hiding ordinary permission errors", () => {
    const propagation = new GcpApiError({
      operation: "create secret",
      status: 403,
      code: 403,
      message: "Secret Manager API has not been used in project 123 before or it is disabled.",
      details: undefined,
    });
    const denied = new GcpApiError({
      operation: "create build",
      status: 403,
      code: 403,
      message: "The caller does not have permission",
      details: undefined,
    });

    expect(isApiPropagationError(propagation)).toBe(true);
    expect(isApiPropagationError(denied)).toBe(false);
  });

  it.effect("retries transient fetch failures at most five attempts", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fakeFetch: typeof fetch = async () => {
        calls += 1;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      };
      const api = new GcpApi({
        project: "cloudbox-project",
        tokenProvider: async () => "test-token",
        fetch: fakeFetch,
        retryBaseDelayMs: 0,
      });

      const error = yield* Effect.flip(
        api.request("test request", "/test", Schema.Struct({ ok: Schema.Boolean })),
      );

      expect(error._tag).toBe("GcpApiError");
      expect(calls).toBe(5);
    }),
  );

  it.effect("retries API activation propagation but not a generic 403", () =>
    Effect.gen(function* () {
      let propagationCalls = 0;
      const propagationFetch: typeof fetch = async () => {
        propagationCalls += 1;
        return propagationCalls < 3
          ? Response.json(
              { error: { code: 403, message: "Cloud Build API is disabled for project 123" } },
              { status: 403 },
            )
          : Response.json({ ok: true });
      };
      const propagationApi = new GcpApi({
        project: "cloudbox-project",
        tokenProvider: async () => "test-token",
        fetch: propagationFetch,
        retryBaseDelayMs: 0,
        propagationRetryMaxMs: 1,
      });
      yield* propagationApi.request("test propagation", "/test", Schema.Struct({ ok: Schema.Boolean }));
      expect(propagationCalls).toBe(3);

      let deniedCalls = 0;
      const deniedApi = new GcpApi({
        project: "cloudbox-project",
        tokenProvider: async () => "test-token",
        fetch: async () => {
          deniedCalls += 1;
          return Response.json(
            { error: { code: 403, message: "The caller does not have permission" } },
            { status: 403 },
          );
        },
        retryBaseDelayMs: 0,
      });
      yield* Effect.flip(deniedApi.request("test denied", "/test", Schema.Unknown));
      expect(deniedCalls).toBe(1);
    }),
  );
});
