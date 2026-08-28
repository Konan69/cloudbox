export interface CloudBuildBodyInput {
  readonly bucketName: string;
  readonly objectName: string;
  readonly imageUri: string;
}

export interface CloudRunBodyInput {
  readonly project: string;
  readonly serviceName: string;
  readonly cloudboxName: string;
  readonly serviceAccountEmail: string;
  readonly imageUri: string;
  readonly zone: string;
  readonly instanceName: string;
  readonly rateLimitBucket: string;
  readonly secretName: string;
  readonly secretVersion: string;
}

export const buildStorageBucketBody = (name: string, location: string, cloudboxName: string) => ({
  name,
  location,
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
  labels: { cloudbox: cloudboxName },
});

export const buildArtifactRepositoryBody = (cloudboxName: string) => ({
  format: "DOCKER",
  description: `Container images for Cloudbox ${cloudboxName} wake service`,
  labels: { cloudbox: cloudboxName },
});

export const buildCloudBuildBody = (input: CloudBuildBodyInput) => ({
  source: {
    storageSource: { bucket: input.bucketName, object: input.objectName },
  },
  steps: [
    {
      name: "gcr.io/cloud-builders/docker",
      args: ["build", "--tag", input.imageUri, "."],
    },
  ],
  images: [input.imageUri],
  options: { logging: "CLOUD_LOGGING_ONLY" },
});

export const buildSecretBody = (cloudboxName: string) => ({
  replication: { automatic: {} },
  labels: { cloudbox: cloudboxName },
});

export const buildCloudRunServiceBody = (input: CloudRunBodyInput) => ({
  labels: { cloudbox: input.cloudboxName },
  ingress: "INGRESS_TRAFFIC_ALL",
  template: {
    serviceAccount: input.serviceAccountEmail,
    timeout: "15s",
    scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
    containers: [
      {
        image: input.imageUri,
        ports: [{ name: "http1", containerPort: 8080 }],
        resources: { limits: { cpu: "1", memory: "256Mi" }, cpuIdle: true },
        env: [
          { name: "GCP_PROJECT", value: input.project },
          { name: "GCP_ZONE", value: input.zone },
          { name: "GCE_INSTANCE", value: input.instanceName },
          { name: "CLOUDBOX_NAME", value: input.cloudboxName },
          { name: "RATE_LIMIT_BUCKET", value: input.rateLimitBucket },
          {
            name: "WAKE_SECRET",
            valueSource: {
              secretKeyRef: { secret: input.secretName, version: input.secretVersion },
            },
          },
        ],
      },
    ],
  },
});
