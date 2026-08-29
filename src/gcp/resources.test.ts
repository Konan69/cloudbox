import { describe, expect, it } from "vitest";

import { diffGcpInstanceProps, type GcpInstanceProps } from "./resources.ts";

const instanceProps: GcpInstanceProps = {
  project: "cloudbox-project",
  zone: "us-central1-a",
  name: "cloudbox-dev",
  machineType: "n2-standard-16",
  bootDiskGb: 80,
  dataDiskName: "cloudbox-dev-data",
  networkTag: "cloudbox-dev",
  startupScript: "#!/bin/bash\necho ready",
  sshPublicKey: "ssh-ed25519 AAAATEST laptop",
  cloudboxName: "dev",
  assetDependencies: ["bootstrap", "idle", "machines"],
};

describe("GCP instance diff", () => {
  it("keeps mutable changes on the in-place update path", () => {
    expect(diffGcpInstanceProps(instanceProps, instanceProps)).toBeUndefined();
    expect(
      diffGcpInstanceProps(instanceProps, {
        ...instanceProps,
        startupScript: "#!/bin/bash\necho updated",
      }),
    ).toEqual({ action: "update" });
  });

  it("replaces the instance only for immutable compute properties", () => {
    expect(
      diffGcpInstanceProps(instanceProps, {
        ...instanceProps,
        machineType: "n2-standard-32",
      }),
    ).toEqual({ action: "replace", deleteFirst: true });
  });
});
