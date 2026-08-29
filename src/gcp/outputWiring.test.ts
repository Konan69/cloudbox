import type { PropsInput } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

import type { GcpInstanceProps } from "./resources.ts";
import type { GcpIamBindingProps } from "./iam.ts";
import type {
  GcpCloudBuildProps,
  GcpCloudRunServiceProps,
  GcpResourceIamBindingProps,
  GcpSecretVersionProps,
  GcpStorageObjectProps,
} from "./platform.ts";
import {
  cloudBuildServiceAccountEmail,
  iamServiceAccountMember,
} from "./outputWiring.ts";

describe("Alchemy GCP resource-output wiring", () => {
  it("defers service-account IAM member interpolation", () => {
    const email = Output.asOutput("cloudbox-wake@example.iam.gserviceaccount.com");

    expect(() => iamServiceAccountMember(email)).not.toThrow();
    expect(Output.isOutput(iamServiceAccountMember(email))).toBe(true);
    expect(Output.isOutput(cloudBuildServiceAccountEmail(Output.asOutput("123456789")))).toBe(true);
  });

  it("typechecks every cross-resource output as an Alchemy input", () => {
    const text = Output.asOutput("resolved-later");
    const secret = Output.asOutput(Redacted.make("resolved-later"));
    const member = iamServiceAccountMember(text);

    const instance = {
      project: "project",
      zone: "europe-west2-b",
      name: "instance",
      machineType: "n2-standard-2",
      bootDiskGb: 30,
      dataDiskName: text,
      networkTag: "instance",
      startupScript: "script",
      sshPublicKey: "key",
      cloudboxName: "dev",
      assetDependencies: [text, text],
    } satisfies PropsInput<GcpInstanceProps>;
    const instanceIam = {
      project: "project",
      zone: "europe-west2-b",
      instanceName: text,
      cloudboxName: "dev",
      serviceAccountEmail: text,
      roleName: text,
    } satisfies PropsInput<GcpIamBindingProps>;
    const object = {
      bucketName: text,
      objectName: "source.tar.gz",
      contentBase64: "archive",
      contentType: "application/gzip",
      sha256: "hash",
      apiService: text,
    } satisfies PropsInput<GcpStorageObjectProps>;
    const build = {
      project: "project",
      location: "europe-west2",
      bucketName: text,
      objectName: text,
      imageUri: "image",
      sourceSha256: "hash",
      dependencies: [text, text],
    } satisfies PropsInput<GcpCloudBuildProps>;
    const secretVersion = {
      secretName: text,
      value: secret,
      apiService: text,
    } satisfies PropsInput<GcpSecretVersionProps>;
    const resourceIam = {
      target: "secret",
      resourceName: text,
      member,
      role: text,
      apiService: text,
    } satisfies PropsInput<GcpResourceIamBindingProps>;
    const cloudRun = {
      project: "project",
      location: "europe-west2",
      serviceName: "wake",
      cloudboxName: "dev",
      serviceAccountEmail: text,
      imageUri: "image",
      zone: "europe-west2-b",
      instanceName: text,
      rateLimitBucket: text,
      allowedOrigins: ["https://app.example.test"],
      secretName: text,
      secretVersion: text,
      buildId: text,
      runtimeBindings: [text, text, text],
      apiService: text,
    } satisfies PropsInput<GcpCloudRunServiceProps>;

    expect({ instance, instanceIam, object, build, secretVersion, resourceIam, cloudRun }).toBeDefined();
  });
});
