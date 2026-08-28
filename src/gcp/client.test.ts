import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { GcpApi } from "./client.ts";

describe("GcpApi operation polling", () => {
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
