import { describe, expect, it } from "vitest";

import {
  buildCustomRoleBody,
  buildDiskInsertBody,
  buildFirewallRuleBody,
  buildIamPolicyWithBinding,
  buildInstanceInsertBody,
  buildServiceAccountBody,
} from "./bodies.ts";

describe("GCP request body builders", () => {
  it("builds a port-22 firewall restricted to the Google IAP range", () => {
    expect(
      buildFirewallRuleBody({
        project: "cloudbox-project",
        name: "cloudbox-dev-ssh",
        targetTag: "cloudbox-dev",
        cloudboxName: "dev",
      }),
    ).toEqual({
      name: "cloudbox-dev-ssh",
      description: "SSH access for cloudbox dev",
      direction: "INGRESS",
      priority: 1000,
      network: "projects/cloudbox-project/global/networks/default",
      allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
      sourceRanges: ["35.235.240.0/20"],
      targetTags: ["cloudbox-dev"],
    });
  });

  it("builds the dedicated wake service account and minimal custom role", () => {
    expect(
      buildServiceAccountBody({ accountId: "cloudbox-wake", cloudboxName: "dev" }),
    ).toEqual({
      accountId: "cloudbox-wake",
      serviceAccount: {
        displayName: "Cloudbox dev wake service",
        description: "Least-privilege identity used by the Cloudbox dev Cloud Run wake service",
      },
    });
    expect(buildCustomRoleBody({ cloudboxName: "dev" }).includedPermissions).toEqual([
      "compute.instances.get",
      "compute.instances.resume",
      "compute.instances.start",
    ]);
  });

  it("adds the wake principal without replacing unrelated instance IAM bindings", () => {
    expect(
      buildIamPolicyWithBinding(
        {
          version: 1,
          etag: "etag-1",
          bindings: [{ role: "roles/compute.viewer", members: ["user:owner@example.com"] }],
        },
        {
          role: "projects/cloudbox-project/roles/cloudboxWake",
          members: ["serviceAccount:cloudbox-wake@cloudbox-project.iam.gserviceaccount.com"],
        },
      ),
    ).toEqual({
      version: 1,
      etag: "etag-1",
      bindings: [
        { role: "roles/compute.viewer", members: ["user:owner@example.com"] },
        {
          role: "projects/cloudbox-project/roles/cloudboxWake",
          members: ["serviceAccount:cloudbox-wake@cloudbox-project.iam.gserviceaccount.com"],
        },
      ],
    });
  });

  it("preserves existing members when adding a project role binding", () => {
    expect(
      buildIamPolicyWithBinding(
        {
          bindings: [
            {
              role: "roles/iap.tunnelResourceAccessor",
              members: ["user:existing@example.com"],
            },
          ],
        },
        {
          role: "roles/iap.tunnelResourceAccessor",
          members: ["user:deployer@example.com"],
        },
      ).bindings,
    ).toEqual([
      {
        role: "roles/iap.tunnelResourceAccessor",
        members: ["user:existing@example.com", "user:deployer@example.com"],
      },
    ]);
  });

  it("builds a separately managed SSD data disk", () => {
    expect(
      buildDiskInsertBody({
        project: "cloudbox-project",
        zone: "us-central1-a",
        name: "cloudbox-dev-data",
        sizeGb: 300,
        type: "pd-ssd",
        cloudboxName: "dev",
      }),
    ).toMatchObject({
      name: "cloudbox-dev-data",
      sizeGb: "300",
      type: "projects/cloudbox-project/zones/us-central1-a/diskTypes/pd-ssd",
      labels: { cloudbox: "dev" },
    });
  });

  it("builds an Intel nested-virtualization instance with bootstrap asset access", () => {
    const body = buildInstanceInsertBody({
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
    });

    expect(body.advancedMachineFeatures.enableNestedVirtualization).toBe(true);
    expect(body.disks[0]).toMatchObject({
      boot: true,
      autoDelete: true,
      initializeParams: {
        sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
        diskSizeGb: "80",
      },
    });
    expect(body.disks[1]).toMatchObject({
      boot: false,
      autoDelete: false,
      deviceName: "cloudbox-dev-data",
    });
    expect(body.networkInterfaces[0]?.accessConfigs).toEqual([
      { name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" },
    ]);
    expect(body.metadata.items).toContainEqual({
      key: "ssh-keys",
      value: "dev:ssh-ed25519 AAAATEST laptop",
    });
    expect(body.scheduling.onHostMaintenance).toBe("MIGRATE");
    expect(body.serviceAccounts[0]?.scopes).toEqual([
      "https://www.googleapis.com/auth/compute",
      "https://www.googleapis.com/auth/devstorage.read_only",
    ]);
    expect(body.labels).toEqual({ cloudbox: "dev" });
  });
});
