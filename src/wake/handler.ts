import * as Data from "effect/Data";

export type WakeState = "running" | "resuming";

export interface WakeGcpClient {
  readonly getInstanceState: (name: string) => Promise<string>;
  readonly resumeInstance: (name: string) => Promise<void>;
  readonly startInstance: (name: string) => Promise<void>;
}

export interface WakeRateLimiter {
  readonly claim: (name: string, nowEpochMs: number) => Promise<boolean>;
}

export interface WakeLogEntry {
  readonly name: string;
  readonly result: string;
  readonly status: number;
  readonly gceState?: string;
}

export interface WakeHandlerOptions {
  readonly expectedName: string;
  readonly bearerSecret: string;
  readonly gcp: WakeGcpClient;
  readonly rateLimiter: WakeRateLimiter;
  readonly now?: () => number;
  readonly log?: (entry: WakeLogEntry) => void;
}

export class WakeGcpError extends Data.TaggedError("WakeGcpError")<{
  readonly operation: string;
  readonly status: number;
  readonly message: string;
}> {}

const json = (body: unknown, status: number) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const bearerToken = (request: Request): string | undefined => {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
};

const equalSecret = async (left: string | undefined, right: string): Promise<boolean> => {
  if (left === undefined) return false;
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
};

export const makeWakeHandler = (options: WakeHandlerOptions) => async (request: Request) => {
  const url = new URL(request.url);
  const prefix = "/wake/";
  const encodedName = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return json({ error: "not_found" }, 404);
  }
  if (encodedName.length === 0 || name.includes("/") || name !== options.expectedName) {
    return json({ error: "not_found" }, 404);
  }

  const finish = (body: unknown, status: number, result: string, gceState?: string) => {
    options.log?.({
      name,
      result,
      status,
      ...(gceState === undefined ? {} : { gceState }),
    });
    return json(body, status);
  };

  if (request.method !== "POST") {
    return finish({ error: "method_not_allowed" }, 405, "method_not_allowed");
  }
  if (!(await equalSecret(bearerToken(request), options.bearerSecret))) {
    return finish({ error: "unauthorized" }, 401, "unauthorized");
  }

  try {
    const state = (await options.gcp.getInstanceState(name)).toUpperCase();
    if (state === "RUNNING") {
      return finish({ state: "running" satisfies WakeState }, 200, "already_running", state);
    }
    if (state === "SUSPENDED" || state === "TERMINATED") {
      const claimed = await options.rateLimiter.claim(name, (options.now ?? Date.now)());
      if (!claimed) {
        return finish(
          { state: "resuming" satisfies WakeState, rateLimited: true },
          202,
          "coalesced",
          state,
        );
      }
      if (state === "SUSPENDED") {
        await options.gcp.resumeInstance(name);
      } else {
        await options.gcp.startInstance(name);
      }
      return finish(
        { state: "resuming" satisfies WakeState },
        202,
        state === "SUSPENDED" ? "resume_requested" : "start_requested",
        state,
      );
    }
    if (["PROVISIONING", "STAGING", "STOPPING", "SUSPENDING", "REPAIRING"].includes(state)) {
      return finish({ state: "resuming" satisfies WakeState }, 202, "transitioning", state);
    }
    return finish({ error: "unsupported_instance_state", state }, 409, "unsupported_state", state);
  } catch (cause) {
    const status = cause instanceof WakeGcpError ? cause.status : 0;
    const operation = cause instanceof WakeGcpError ? cause.operation : "wake";
    console.error("cloudbox wake failed", {
      name,
      operation,
      upstreamStatus: status,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return finish({ error: "gcp_request_failed" }, 502, "gcp_error");
  }
};
