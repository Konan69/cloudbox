import { GoogleAuth } from "google-auth-library";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { GcpCredentials } from "../config.ts";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), path.slice(2))
    : NodePath.resolve(path);

export type AccessTokenProvider = () => Promise<string>;

export class GcpPrincipalResolutionError extends Error {
  override readonly name = "GcpPrincipalResolutionError";
}

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

export const resolvePrincipalFromAccessToken = async (
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> => {
  if (accessToken.length === 0) {
    throw new GcpPrincipalResolutionError(
      "Cannot resolve the deploying principal: the ADC access token is empty",
    );
  }

  let response: Response;
  try {
    const url = new URL(TOKENINFO_URL);
    url.searchParams.set("access_token", accessToken);
    response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (cause) {
    throw new GcpPrincipalResolutionError(
      "Cannot resolve the deploying principal from the ADC token via Google tokeninfo",
      { cause },
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new GcpPrincipalResolutionError(
      `Cannot resolve the deploying principal from Google tokeninfo: HTTP ${String(response.status)}${text.length === 0 ? "" : `: ${text}`}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new GcpPrincipalResolutionError(
      "Cannot resolve the deploying principal: Google tokeninfo returned invalid JSON",
      { cause },
    );
  }
  const email = value !== null && typeof value === "object" && "email" in value
    ? Reflect.get(value, "email")
    : undefined;
  if (typeof email !== "string" || email.trim().length === 0 || !email.includes("@")) {
    throw new GcpPrincipalResolutionError(
      "Cannot resolve the deploying principal: Google tokeninfo returned no email",
    );
  }
  const normalized = email.trim();
  return normalized.endsWith(".gserviceaccount.com")
    ? `serviceAccount:${normalized}`
    : `user:${normalized}`;
};

export const makeAccessTokenProvider = (
  credentials: GcpCredentials,
): AccessTokenProvider => {
  const auth = new GoogleAuth({
    scopes: [CLOUD_PLATFORM_SCOPE],
    ...(credentials === "adc"
      ? {}
      : { keyFile: expandHome(credentials.serviceAccountJsonPath) }),
  });

  return async () => {
    const token = await auth.getAccessToken();
    if (token === null || token === undefined || token.length === 0) {
      throw new Error("Google Application Default Credentials returned no access token");
    }
    return token;
  };
};

export const resolveDeployingPrincipal = async (
  credentials: GcpCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> => {
  let accessToken: string;
  try {
    accessToken = await makeAccessTokenProvider(credentials)();
  } catch (cause) {
    throw new GcpPrincipalResolutionError(
      "Cannot resolve the deploying principal: ADC did not provide an access token",
      { cause },
    );
  }
  return resolvePrincipalFromAccessToken(accessToken, fetchImpl);
};
