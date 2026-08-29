import { describe, expect, it } from "vitest";

import type { AwsCloudboxConfig, GcpCloudboxConfig } from "../config.ts";
import {
  assertSshPrerequisites,
  buildSshTransport,
  SshTransportError,
} from "./transport.ts";

const shared = {
  name: "dev",
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: { repoUrl: "https://example.test/t3.git", branch: "main" },
  identity: { paths: ["~/.pi/"], excludes: ["sessions/"], maxTransferMb: 100 },
  boxUser: "dev" as const,
};

const awsConfig: AwsCloudboxConfig = {
  ...shared,
  provider: "aws",
  aws: { sshCidr: "203.0.113.10/32" },
  region: "us-east-1",
  instanceType: "m7i.4xlarge",
  diskGb: 300,
};

const gcpConfig: GcpCloudboxConfig = {
  ...shared,
  provider: "gcp",
  gcp: {
    project: "cloudbox-project",
    zone: "us-central1-a",
    machineType: "n2-standard-16",
    bootDiskGb: 50,
    dataDiskGb: 300,
    dataDiskType: "pd-ssd",
    credentials: "adc",
  },
};

describe("SSH transport", () => {
  it("builds GCP SSH and rsync arguments through IAP by instance name", () => {
    const transport = buildSshTransport(gcpConfig);
    const args = transport.args({ batchMode: true });

    expect(transport.host).toBe("cloudbox-dev");
    expect(transport.target).toBe("dev@cloudbox-dev");
    expect(args).toContain(
      "ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project cloudbox-project --zone us-central1-a --verbosity=warning",
    );
    expect(args).toContain("UserKnownHostsFile=~/.ssh/cloudbox_known_hosts");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args.at(-1)).toBe("dev@cloudbox-dev");
    expect(transport.rsyncRemoteShell()).toContain("start-iap-tunnel %h %p");
  });

  it("builds direct AWS SSH arguments to the supplied public IP", () => {
    const transport = buildSshTransport(awsConfig, "203.0.113.20");
    const args = transport.args();

    expect(transport.host).toBe("203.0.113.20");
    expect(args.at(-1)).toBe("dev@203.0.113.20");
    expect(args.join(" ")).not.toContain("ProxyCommand");
    expect(args.join(" ")).not.toContain("UserKnownHostsFile");
  });

  it("rejects host overrides for GCP", () => {
    expect(() => buildSshTransport(gcpConfig, "203.0.113.20")).toThrow(
      "--host is AWS-only",
    );
  });

  it("fails clearly when gcloud is missing", () => {
    expect(() =>
      assertSshPrerequisites(gcpConfig, {
        path: "/missing/bin",
        isExecutable: () => false,
      })
    ).toThrow(SshTransportError);
    expect(() =>
      assertSshPrerequisites(gcpConfig, {
        path: "/missing/bin",
        isExecutable: () => false,
      })
    ).toThrow("gcloud is required for GCP SSH through IAP");
  });
});
