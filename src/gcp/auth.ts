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
