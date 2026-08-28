export interface FirewallRuleBodyInput {
  readonly project: string;
  readonly name: string;
  readonly sshCidr: string;
  readonly targetTag: string;
  readonly cloudboxName: string;
}

export interface DiskBodyInput {
  readonly project: string;
  readonly zone: string;
  readonly name: string;
  readonly sizeGb: number;
  readonly type: "pd-ssd" | "pd-balanced";
  readonly cloudboxName: string;
}

export interface InstanceBodyInput {
  readonly project: string;
  readonly zone: string;
  readonly name: string;
  readonly machineType: string;
  readonly bootDiskGb: number;
  readonly dataDiskName: string;
  readonly networkTag: string;
  readonly startupScript: string;
  readonly sshPublicKey: string;
  readonly cloudboxName: string;
}

export interface ServiceAccountBodyInput {
  readonly accountId: string;
  readonly cloudboxName: string;
}

export interface CustomRoleBodyInput {
  readonly cloudboxName: string;
}

export interface IamPolicyBinding {
  readonly role: string;
  readonly members: ReadonlyArray<string>;
  readonly condition?: {
    readonly title: string;
    readonly description?: string | undefined;
    readonly expression: string;
  } | undefined;
}

export interface IamPolicy {
  readonly version?: number | undefined;
  readonly etag?: string | undefined;
  readonly bindings?: ReadonlyArray<IamPolicyBinding> | undefined;
}

export const buildFirewallRuleBody = (input: FirewallRuleBodyInput) => ({
  name: input.name,
  description: `SSH access for cloudbox ${input.cloudboxName}`,
  direction: "INGRESS",
  priority: 1000,
  network: `projects/${input.project}/global/networks/default`,
  allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
  sourceRanges: [input.sshCidr],
  targetTags: [input.targetTag],
});

export const buildDiskInsertBody = (input: DiskBodyInput) => ({
  name: input.name,
  description: `Cloudbox ${input.cloudboxName} data disk`,
  sizeGb: String(input.sizeGb),
  type: `projects/${input.project}/zones/${input.zone}/diskTypes/${input.type}`,
  physicalBlockSizeBytes: "4096",
  labels: { cloudbox: input.cloudboxName },
});

export const buildServiceAccountBody = (input: ServiceAccountBodyInput) => ({
  accountId: input.accountId,
  serviceAccount: {
    displayName: `Cloudbox ${input.cloudboxName} wake service`,
    description: `Least-privilege identity used by the Cloudbox ${input.cloudboxName} wake Worker`,
  },
});

export const buildCustomRoleBody = (input: CustomRoleBodyInput) => ({
  title: `Cloudbox ${input.cloudboxName} wake`,
  description: `Get, resume, or start only the Cloudbox ${input.cloudboxName} instance selected by its instance IAM policy`,
  includedPermissions: [
    "compute.instances.get",
    "compute.instances.resume",
    "compute.instances.start",
  ],
  stage: "GA",
});

export const buildIamPolicyWithBinding = (
  policy: IamPolicy,
  binding: IamPolicyBinding,
): IamPolicy => {
  const bindings = (policy.bindings ?? []).filter(
    (current) =>
      current.role !== binding.role ||
      JSON.stringify(current.condition) !== JSON.stringify(binding.condition),
  );
  return {
    version: Math.max(policy.version ?? 1, binding.condition === undefined ? 1 : 3),
    ...(policy.etag === undefined ? {} : { etag: policy.etag }),
    bindings: [...bindings, binding],
  };
};

export const buildInstanceInsertBody = (input: InstanceBodyInput) => ({
  name: input.name,
  machineType: `projects/${input.project}/zones/${input.zone}/machineTypes/${input.machineType}`,
  advancedMachineFeatures: { enableNestedVirtualization: true },
  disks: [
    {
      boot: true,
      autoDelete: true,
      type: "PERSISTENT",
      initializeParams: {
        sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
        diskSizeGb: String(input.bootDiskGb),
        diskType: `projects/${input.project}/zones/${input.zone}/diskTypes/pd-balanced`,
      },
    },
    {
      boot: false,
      autoDelete: false,
      type: "PERSISTENT",
      deviceName: input.dataDiskName,
      source: `projects/${input.project}/zones/${input.zone}/disks/${input.dataDiskName}`,
      mode: "READ_WRITE",
    },
  ],
  networkInterfaces: [
    {
      network: `projects/${input.project}/global/networks/default`,
      accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }],
    },
  ],
  tags: { items: [input.networkTag] },
  metadata: {
    items: [
      { key: "startup-script", value: input.startupScript },
      { key: "ssh-keys", value: `dev:${input.sshPublicKey.trim()}` },
    ],
  },
  serviceAccounts: [
    {
      email: "default",
      scopes: ["https://www.googleapis.com/auth/compute"],
    },
  ],
  scheduling: {
    onHostMaintenance: "MIGRATE",
    automaticRestart: true,
    preemptible: false,
    provisioningModel: "STANDARD",
  },
  labels: { cloudbox: input.cloudboxName },
});
