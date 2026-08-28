import * as Effect from "effect/Effect";

import {
  makeWakeHandler,
  WakeGcpError,
  type WakeGcpClient,
  type WakeRateLimiter,
} from "./handler.ts";

interface WakeKvNamespace {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number },
  ) => Promise<void>;
}

interface WakeWorkerEnv {
  readonly GCP_PROJECT: string;
  readonly GCP_ZONE: string;
  readonly GCE_INSTANCE: string;
  readonly CLOUDBOX_NAME: string;
  readonly GCP_SERVICE_ACCOUNT_KEY: string;
  readonly WAKE_SECRET: string;
  readonly WAKE_RATE_LIMIT: WakeKvNamespace;
}

interface ServiceAccountCredentials {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

interface TokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
}

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

const base64url = (value: Uint8Array | string): string => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const pemBytes = (pem: string): Uint8Array => {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll(/\s/gu, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const parseCredentials = (json: string): ServiceAccountCredentials => {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !("client_email" in value) ||
    !("private_key" in value) ||
    typeof value.client_email !== "string" ||
    typeof value.private_key !== "string"
  ) {
    throw new Error("GCP_SERVICE_ACCOUNT_KEY is not a service-account credentials JSON object");
  }
  return value as ServiceAccountCredentials;
};

export const makeWorkerGcpClient = (
  env: Pick<WakeWorkerEnv, "GCP_PROJECT" | "GCP_ZONE" | "GCE_INSTANCE" | "GCP_SERVICE_ACCOUNT_KEY">,
  fetchImpl: typeof fetch = fetch,
): WakeGcpClient => {
  const credentials = parseCredentials(env.GCP_SERVICE_ACCOUNT_KEY);
  let cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;

  const accessToken = async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken !== undefined && cachedToken.expiresAt - 60_000 > now) {
      return cachedToken.value;
    }
    const issuedAt = Math.floor(now / 1_000);
    const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: COMPUTE_SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3_600,
      }),
    );
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemBytes(credentials.private_key).buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
    const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
    const response = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const body = (await response.json()) as TokenResponse;
    if (!response.ok || typeof body.access_token !== "string") {
      throw new WakeGcpError({
        operation: "service-account OAuth token exchange",
        status: response.status,
        message: "Google OAuth token exchange failed",
      });
    }
    cachedToken = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3_600) * 1_000,
    };
    return cachedToken.value;
  };

  const request = async (operation: string, suffix = "", method = "GET") => {
    const url =
      `${COMPUTE_API}/projects/${encodeURIComponent(env.GCP_PROJECT)}` +
      `/zones/${encodeURIComponent(env.GCP_ZONE)}/instances/${encodeURIComponent(env.GCE_INSTANCE)}` +
      suffix;
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new WakeGcpError({
        operation,
        status: response.status,
        message: `${operation} returned HTTP ${String(response.status)}`,
      });
    }
    return response;
  };

  const changeState = async (operation: "resume" | "start") => {
    const requestId = crypto.randomUUID();
    await request(
      `${operation} ${env.GCE_INSTANCE}`,
      `/${operation}?requestId=${encodeURIComponent(requestId)}`,
      "POST",
    );
  };

  return {
    getInstanceState: async () => {
      const response = await request(`get ${env.GCE_INSTANCE}`);
      const body = (await response.json()) as { readonly status?: unknown };
      if (typeof body.status !== "string") {
        throw new WakeGcpError({
          operation: `get ${env.GCE_INSTANCE}`,
          status: response.status,
          message: "Compute Engine response did not contain an instance status",
        });
      }
      return body.status;
    },
    resumeInstance: async () => changeState("resume"),
    startInstance: async () => changeState("start"),
  };
};

export const makeKvRateLimiter = (kv: WakeKvNamespace): WakeRateLimiter => ({
  claim: async (name, nowEpochMs) => {
    const key = `wake:${name}`;
    const previous = await kv.get(key);
    if (previous !== null) {
      const previousEpochMs = Number(previous);
      if (Number.isFinite(previousEpochMs) && nowEpochMs - previousEpochMs < 60_000) {
        return false;
      }
    }
    await kv.put(key, String(nowEpochMs), { expirationTtl: 60 });
    return true;
  },
});

let cached:
  | { readonly keyJson: string; readonly project: string; readonly zone: string; readonly client: WakeGcpClient }
  | undefined;

const gcpClient = (env: WakeWorkerEnv): WakeGcpClient => {
  if (
    cached === undefined ||
    cached.keyJson !== env.GCP_SERVICE_ACCOUNT_KEY ||
    cached.project !== env.GCP_PROJECT ||
    cached.zone !== env.GCP_ZONE
  ) {
    cached = {
      keyJson: env.GCP_SERVICE_ACCOUNT_KEY,
      project: env.GCP_PROJECT,
      zone: env.GCP_ZONE,
      client: makeWorkerGcpClient(env),
    };
  }
  return cached.client;
};

export default {
  fetch: (request: Request, env: WakeWorkerEnv): Promise<Response> =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          makeWakeHandler({
            expectedName: env.CLOUDBOX_NAME,
            bearerSecret: env.WAKE_SECRET,
            gcp: gcpClient(env),
            rateLimiter: makeKvRateLimiter(env.WAKE_RATE_LIMIT),
            log: (entry) => console.info("cloudbox wake", entry),
          })(request),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchCause((cause) => {
          console.error("cloudbox wake handler crashed", { error: String(cause) });
          return Effect.succeed(Response.json({ error: "internal_error" }, { status: 500 }));
        }),
      ),
    ),
};
