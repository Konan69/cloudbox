import { describe, expect, it } from "vitest";

import { makeGcsRateLimiter } from "./gcpRuntime.ts";

describe("GCS wake rate-limit store", () => {
  it("persists a claim and rejects another claim inside 60 seconds", async () => {
    let stored: { readonly value: string; readonly generation: string } | undefined;
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "metadata-token", expires_in: 3600 });
      }
      if (url.includes("upload/storage/v1")) {
        stored = { value: String(init?.body), generation: "1" };
        return Response.json({ bucket: "rate-bucket", name: "wake-rate/dev", generation: "1" });
      }
      if (url.includes("alt=media")) {
        return new Response(stored?.value ?? "", { status: stored === undefined ? 404 : 200 });
      }
      return stored === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({ bucket: "rate-bucket", name: "wake-rate/dev", generation: stored.generation });
    };
    const store = makeGcsRateLimiter("rate-bucket", fakeFetch);

    expect(await store.claim("dev", 100_000)).toBe(true);
    expect(await store.claim("dev", 159_999)).toBe(false);
    expect(requests.filter((url) => url.includes("upload/storage/v1"))).toHaveLength(1);
  });

  it("loses a concurrent conditional-create race without issuing a second wake", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        return Response.json({ access_token: "metadata-token", expires_in: 3600 });
      }
      if (url.includes("upload/storage/v1")) {
        return Response.json({ error: "precondition" }, { status: 412 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    };

    expect(await makeGcsRateLimiter("rate-bucket", fakeFetch).claim("dev", 100_000)).toBe(false);
  });
});
