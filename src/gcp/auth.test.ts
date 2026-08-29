import { describe, expect, it } from "vitest";

import {
  GcpPrincipalResolutionError,
  resolvePrincipalFromAccessToken,
} from "./auth.ts";

describe("GCP deploying principal resolution", () => {
  it("resolves a user IAM member from Google tokeninfo", async () => {
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      requests.push(String(input));
      return Response.json({ email: "deployer@example.com" });
    };

    await expect(resolvePrincipalFromAccessToken("adc-token", fakeFetch)).resolves.toBe(
      "user:deployer@example.com",
    );
    expect(requests).toEqual([
      "https://oauth2.googleapis.com/tokeninfo?access_token=adc-token",
    ]);
  });

  it("resolves a service-account IAM member", async () => {
    const fakeFetch: typeof fetch = async () =>
      Response.json({ email: "deploy@cloudbox-project.iam.gserviceaccount.com" });

    await expect(resolvePrincipalFromAccessToken("adc-token", fakeFetch)).resolves.toBe(
      "serviceAccount:deploy@cloudbox-project.iam.gserviceaccount.com",
    );
  });

  it("fails loudly when tokeninfo has no email", async () => {
    const fakeFetch: typeof fetch = async () => Response.json({ scope: "cloud-platform" });

    await expect(resolvePrincipalFromAccessToken("adc-token", fakeFetch)).rejects.toThrow(
      GcpPrincipalResolutionError,
    );
    await expect(resolvePrincipalFromAccessToken("adc-token", fakeFetch)).rejects.toThrow(
      "tokeninfo returned no email",
    );
  });
});
