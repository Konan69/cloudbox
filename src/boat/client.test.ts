import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BoatApiError,
  BoatDecodeError,
  makeBoatClient,
} from "./client.ts";

const sandbox = {
  id: "SANDBOX_ID",
  name: "cloudbox-dev",
  state: "ready",
  type: "default",
  ip: "203.0.113.40",
  desktopAvailable: true,
  snapshotAvailable: true,
};

const response = (value: unknown, status = 200) => Response.json(value, { status });

describe("BoatClient", () => {
  it.effect("covers lifecycle, exec polling, and SSH against a fake HTTP layer", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
      const replies: Array<Response> = [
        response({
          ok: true,
          type: "limits.info",
          canStart: true,
          activeSandboxes: 0,
          maxActiveSandboxes: 2,
          billingStatus: "trial",
        }),
        response({
          ok: true,
          type: "sandbox.created",
          status: "provisioning",
          ttlSeconds: 7200,
          sandbox: { ...sandbox, state: "provisioning" },
        }, 202),
        response({ ok: true, type: "sandbox.info", sandbox }),
        response({
          ok: true,
          type: "sandbox.list",
          sandboxes: [sandbox],
          pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
        }),
        response({ ok: true, type: "sandbox.stopping", id: sandbox.id, status: "archiving", sandbox }, 202),
        response({ ok: true, type: "sandbox.resuming", id: sandbox.id, status: "resuming", sandbox }, 202),
        response({ ok: true, type: "sandbox.forking", id: "SANDBOX_ID", status: "forking", sandbox: { ...sandbox, id: "SANDBOX_ID" } }, 202),
        response({ ok: true, type: "sandbox.updated", sandbox: { ...sandbox, archiveAfter: null } }),
        response({ ok: true, type: "sandbox.updated", sandbox: { ...sandbox, name: "renamed" } }),
        response({
          ok: true,
          type: "command.finished",
          success: true,
          exitCode: 0,
          stdout: "done\n",
          stderr: "",
          timedOut: false,
        }),
        response({
          ok: true,
          type: "command.started",
          success: true,
          processId: 42,
          pid: 42,
          command: "vp run build",
          startedAt: "2026-09-20T12:00:00Z",
        }),
        response({
          ok: true,
          type: "command.status",
          success: true,
          processId: 42,
          status: "running",
          running: true,
          exitCode: null,
          stdout: "building",
          stderr: "",
        }),
        response({
          ok: true,
          type: "command.status",
          success: true,
          processId: 42,
          status: "exited",
          running: false,
          exitCode: 0,
          stdout: "built\n",
          stderr: "",
        }),
        response({
          ok: true,
          type: "ssh_key.configured",
          success: true,
          machineIp: "203.0.113.40",
          sshUser: "user",
        }),
        response({
          ok: true,
          type: "sandbox.deleting",
          operation: {
            id: `bdop_${"a".repeat(32)}`,
            kind: "sandbox",
            targetId: sandbox.id,
            reason: "explicit",
            status: "pending",
            attemptCount: 0,
            requestedAt: "2026-09-20T12:00:00Z",
            completedAt: null,
          },
        }, 202),
      ];
      const fakeFetch: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        const next = replies.shift();
        if (next === undefined) throw new Error("unexpected fake request");
        return next;
      };
      const client = makeBoatClient({
        apiKey: "boat_test",
        baseUrl: "https://boat.test/api/v1/",
        fetch: fakeFetch,
        pollIntervalMs: 0,
        maxPolls: 3,
      });

      expect((yield* client.limits).canStart).toBe(true);
      expect((yield* client.create({
        type: "default",
        ttlSeconds: 7200,
        environment: "base",
        idempotencyKey: "create-key",
      })).sandbox.id).toBe(sandbox.id);
      expect((yield* client.get(sandbox.id)).ip).toBe("203.0.113.40");
      expect((yield* client.list()).sandboxes).toHaveLength(1);
      yield* client.stop(sandbox.id);
      yield* client.resume(sandbox.id, { type: "large", ttlSeconds: null, environment: "base" });
      expect((yield* client.fork(sandbox.id, {
        type: "small",
        ttlSeconds: 600,
        idempotencyKey: "fork-key",
      })).id).toBe("SANDBOX_ID");
      expect((yield* client.updateTtl(sandbox.id, null)).archiveAfter).toBeNull();
      expect((yield* client.updateName(sandbox.id, "renamed")).name).toBe("renamed");
      expect((yield* client.exec(sandbox.id, { command: "true", timeoutSeconds: 60 })).stdout).toBe("done\n");
      expect((yield* client.execDetachedAndWait(sandbox.id, { command: "vp run build" })).stdout).toBe("built\n");
      expect((yield* client.configureSshKey(sandbox.id, "ssh-ed25519 AAAA test")).sshUser).toBe("user");
      expect((yield* client.delete(sandbox.id)).operation.targetId).toBe(sandbox.id);

      expect(requests).toHaveLength(15);
      expect(requests[0]?.url).toBe("https://boat.test/api/v1/limits");
      expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer boat_test");
      expect(new Headers(requests[1]?.init?.headers).get("Idempotency-Key")).toBe("create-key");
      expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
        type: "default",
        ttlSeconds: 7200,
        environment: "base",
      });
      expect(requests[3]?.url).toContain("limit=200");
      expect(JSON.parse(String(requests[5]?.init?.body))).toEqual({
        type: "large",
        ttlSeconds: null,
        environment: "base",
      });
      expect(JSON.parse(String(requests[10]?.init?.body))).toEqual({
        command: "vp run build",
        detached: true,
      });
      expect(requests[14]?.init?.method).toBe("DELETE");
      expect(new Headers(requests[14]?.init?.headers).get("X-Ascii-Confirm-Delete")).toBe(sandbox.id);
    }),
  );

  it.effect("fails when a successful response is missing a required key", () =>
    Effect.gen(function* () {
      const client = makeBoatClient({
        apiKey: "boat_test",
        fetch: async () => response({ ok: true, type: "sandbox.info" }),
      });

      const error = yield* client.get(sandbox.id).pipe(Effect.flip);
      expect(error).toBeInstanceOf(BoatDecodeError);
      expect(error.message).toContain("unexpected response");
    }),
  );

  it.effect("schema-decodes the structured API error instead of falling back to HTTP text", () =>
    Effect.gen(function* () {
      const client = makeBoatClient({
        apiKey: "boat_test",
        fetch: async () => response({
          ok: false,
          type: "sandbox.error",
          status: 409,
          code: "account_not_ready",
          message: "Checkout is required",
          error: { code: "account_not_ready", message: "Checkout is required", status: 409 },
          requestId: "req_test",
        }, 409),
      });

      const error = yield* client.limits.pipe(Effect.flip);
      expect(error).toBeInstanceOf(BoatApiError);
      if (error instanceof BoatApiError) {
        expect(error.code).toBe("account_not_ready");
        expect(error.requestId).toBe("req_test");
      }
    }),
  );
});
