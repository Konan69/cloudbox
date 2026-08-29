import * as Data from "effect/Data";

export type WakeState = "running" | "resuming";
export type WakeStatusState = "suspended" | "running" | "resuming" | "stopped" | "other";

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
  readonly allowedOrigins: ReadonlyArray<string>;
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

const statusState = (gceStatus: string): WakeStatusState => {
  switch (gceStatus.toUpperCase()) {
    case "SUSPENDED":
      return "suspended";
    case "RUNNING":
      return "running";
    case "RESUMING":
    case "PROVISIONING":
    case "STAGING":
      return "resuming";
    case "TERMINATED":
    case "STOPPING":
      return "stopped";
    default:
      return "other";
  }
};

type WakeRoute = "wake" | "status";

const matchRoute = (pathname: string): { readonly route: WakeRoute; readonly encodedName: string } | undefined => {
  for (const route of ["wake", "status"] as const) {
    const prefix = `/${route}/`;
    if (pathname.startsWith(prefix)) {
      return { route, encodedName: pathname.slice(prefix.length) };
    }
  }
  return undefined;
};

export const makeWakeHandler = (options: WakeHandlerOptions) => {
  const allowedOrigins = new Set(options.allowedOrigins);

  return async (request: Request) => {
    const responseHeaders = (preflight = false) => {
      const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
      const origin = request.headers.get("origin");
      if (origin !== null && allowedOrigins.has(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        if (preflight) {
          headers.set("Access-Control-Allow-Headers", "authorization, content-type");
          headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        }
      }
      return headers;
    };
    const json = (body: unknown, status: number, headers = responseHeaders()) =>
      Response.json(body, { status, headers });

    const url = new URL(request.url);
    const matched = matchRoute(url.pathname);
    if (matched === undefined) return json({ error: "not_found" }, 404);

    let name: string;
    try {
      name = decodeURIComponent(matched.encodedName);
    } catch {
      return json({ error: "not_found" }, 404);
    }
    if (
      matched.encodedName.length === 0 ||
      name.includes("/") ||
      name !== options.expectedName
    ) {
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

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: responseHeaders(true) });
    }

    const expectedMethod = matched.route === "wake" ? "POST" : "GET";
    if (request.method !== expectedMethod) {
      const headers = responseHeaders();
      headers.set("Allow", `${expectedMethod}, OPTIONS`);
      options.log?.({ name, result: "method_not_allowed", status: 405 });
      return json({ error: "method_not_allowed" }, 405, headers);
    }
    if (!(await equalSecret(bearerToken(request), options.bearerSecret))) {
      return finish({ error: "unauthorized" }, 401, "unauthorized");
    }

    try {
      const rawState = await options.gcp.getInstanceState(name);
      const state = rawState.toUpperCase();

      if (matched.route === "status") {
        return finish(
          { state: statusState(rawState), gceStatus: rawState, name },
          200,
          "status",
          state,
        );
      }

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
      const operation = cause instanceof WakeGcpError ? cause.operation : matched.route;
      console.error("cloudbox wake service request failed", {
        name,
        operation,
        upstreamStatus: status,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return finish({ error: "gcp_request_failed" }, 502, "gcp_error");
    }
  };
};
