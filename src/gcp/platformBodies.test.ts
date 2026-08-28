import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  buildArtifactRepositoryBody,
  buildCloudBuildBody,
  buildCloudRunServiceBody,
  buildSecretBody,
  buildStorageBucketBody,
} from "./platformBodies.ts";
import { makeWakeSourceArchive } from "./sourceArchive.ts";

describe("GCP wake platform request bodies", () => {
  it("builds owned GCS, Artifact Registry, and Secret Manager resources", () => {
    expect(buildStorageBucketBody("wake-source", "europe-west2", "dev")).toMatchObject({
      name: "wake-source",
      location: "europe-west2",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      labels: { cloudbox: "dev" },
    });
    expect(buildArtifactRepositoryBody("dev")).toEqual({
      format: "DOCKER",
      description: "Container images for Cloudbox dev wake service",
      labels: { cloudbox: "dev" },
    });
    expect(buildSecretBody("dev")).toEqual({
      replication: { automatic: {} },
      labels: { cloudbox: "dev" },
    });
  });

  it("builds a Cloud Build Docker image request from the uploaded source archive", () => {
    expect(
      buildCloudBuildBody({
        bucketName: "wake-source",
        objectName: "wake-abc.tar.gz",
        imageUri: "europe-west2-docker.pkg.dev/project/cloudbox-wake/service:abc",
      }),
    ).toEqual({
      source: { storageSource: { bucket: "wake-source", object: "wake-abc.tar.gz" } },
      steps: [
        {
          name: "gcr.io/cloud-builders/docker",
          args: [
            "build",
            "--tag",
            "europe-west2-docker.pkg.dev/project/cloudbox-wake/service:abc",
            ".",
          ],
        },
      ],
      images: ["europe-west2-docker.pkg.dev/project/cloudbox-wake/service:abc"],
      options: { logging: "CLOUD_LOGGING_ONLY" },
    });
  });

  it("builds Cloud Run v2 service identity, secret, and runtime configuration", () => {
    const body = buildCloudRunServiceBody({
      project: "cloudbox-project",
      serviceName: "cloudbox-dev-wake",
      cloudboxName: "dev",
      serviceAccountEmail: "cloudbox-wake@cloudbox-project.iam.gserviceaccount.com",
      imageUri: "europe-west2-docker.pkg.dev/cloudbox-project/cloudbox-wake/service:abc",
      zone: "europe-west2-b",
      instanceName: "cloudbox-dev",
      rateLimitBucket: "wake-rate",
      secretName: "projects/cloudbox-project/secrets/cloudbox-dev-wake",
      secretVersion: "3",
    });

    expect(body.template.serviceAccount).toBe(
      "cloudbox-wake@cloudbox-project.iam.gserviceaccount.com",
    );
    expect(body.template.containers[0]?.image).toContain("cloudbox-wake/service:abc");
    expect(body.template.containers[0]?.env).toContainEqual({
      name: "WAKE_SECRET",
      valueSource: {
        secretKeyRef: {
          secret: "projects/cloudbox-project/secrets/cloudbox-dev-wake",
          version: "3",
        },
      },
    });
    expect(body.template.containers[0]?.env).toContainEqual({
      name: "RATE_LIMIT_BUCKET",
      value: "wake-rate",
    });
  });

  it("creates a gzip tar source archive containing the Dockerfile and wake bundle", () => {
    const first = makeWakeSourceArchive("console.log('wake')\n");
    const second = makeWakeSourceArchive("console.log('wake')\n");
    const tar = gunzipSync(first.bytes);

    expect(first.sha256).toBe(second.sha256);
    expect(tar.includes(Buffer.from("Dockerfile"))).toBe(true);
    expect(tar.includes(Buffer.from("wake-service.mjs"))).toBe(true);
    expect(tar.includes(Buffer.from("console.log('wake')"))).toBe(true);
  });
});
