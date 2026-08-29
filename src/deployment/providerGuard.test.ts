import { describe, expect, it } from "vitest";

import { assertProviderMatchesState, providerFromResourceType } from "./providerGuard.ts";

describe("provider deployment guard", () => {
  it("recognizes the provider recorded by the Cloudbox instance resource", () => {
    expect(providerFromResourceType("GCP.Compute.Instance")).toBe("gcp");
    expect(providerFromResourceType("AWS.CloudFormation.Stack")).toBe("aws");
  });

  it("allows a first deploy and a deploy to the same provider", () => {
    expect(() => assertProviderMatchesState("gcp", undefined, "dev_dev")).not.toThrow();
    expect(() => assertProviderMatchesState("gcp", "GCP.Compute.Instance", "dev_dev")).not.toThrow();
  });

  it("blocks treating a provider config edit as an infrastructure migration", () => {
    expect(() =>
      assertProviderMatchesState("aws", "GCP.Compute.Instance", "dev_dev"),
    ).toThrowError(
      /stage dev_dev is already deployed on gcp.*changing provider to aws is not a migration/i,
    );
  });

  it("blocks an unknown existing instance resource instead of guessing", () => {
    expect(() => assertProviderMatchesState("gcp", "Other.Instance", "prod")).toThrowError(
      /cannot determine the deployed provider/i,
    );
  });
});
