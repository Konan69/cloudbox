import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { buildIamPolicyWithBinding, type IamPolicy, type IamPolicyBinding } from "./bodies.ts";
import { GcpApi, GoogleLongRunningOperation } from "./client.ts";
import {
  buildArtifactRepositoryBody,
  buildCloudBuildBody,
  buildCloudRunServiceBody,
  buildSecretBody,
  buildStorageBucketBody,
  type CloudRunBodyInput,
} from "./platformBodies.ts";
import type { Providers } from "./providers.ts";

const SERVICE_USAGE_API = "https://serviceusage.googleapis.com/v1";
const STORAGE_API = "https://storage.googleapis.com/storage/v1";
const STORAGE_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";
const ARTIFACT_API = "https://artifactregistry.googleapis.com/v1";
const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";
const SECRET_MANAGER_API = "https://secretmanager.googleapis.com/v1";
const CLOUD_RUN_API = "https://run.googleapis.com/v2";
const CLOUD_RESOURCE_MANAGER_API = "https://cloudresourcemanager.googleapis.com/v1";

const EmptyResponse = Schema.Unknown;
const Labels = Schema.Record(Schema.String, Schema.String);
const ServiceUsageResponse = Schema.Struct({ name: Schema.NonEmptyString, state: Schema.NonEmptyString });
export const GcpProjectResponse = Schema.Struct({
  projectId: Schema.NonEmptyString,
  projectNumber: Schema.NonEmptyString,
});
const BucketResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  location: Schema.NonEmptyString,
  labels: Schema.optional(Labels),
});
const StorageObjectResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  bucket: Schema.NonEmptyString,
  generation: Schema.optional(Schema.String),
});
const StorageObjectListResponse = Schema.Struct({
  items: Schema.optional(Schema.Array(StorageObjectResponse)),
});
const RepositoryResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  format: Schema.NonEmptyString,
  labels: Schema.optional(Labels),
});
const BuildResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});
const SecretResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  labels: Schema.optional(Labels),
});
const SecretVersionResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  state: Schema.optional(Schema.String),
});
const CloudRunServiceResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  uri: Schema.optional(Schema.NonEmptyString),
  labels: Schema.optional(Labels),
});
const IamCondition = Schema.Struct({
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  expression: Schema.NonEmptyString,
});
const IamBindingResponse = Schema.Struct({
  role: Schema.NonEmptyString,
  members: Schema.Array(Schema.NonEmptyString),
  condition: Schema.optional(IamCondition),
});
const IamPolicyResponse = Schema.Struct({
  version: Schema.optional(Schema.Number),
  etag: Schema.optional(Schema.String),
  bindings: Schema.optional(Schema.Array(IamBindingResponse)),
});

export class GcpPlatformResourceError extends Data.TaggedError("GcpPlatformResourceError")<{
  readonly resource: string;
  readonly message: string;
}> {}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const owned = (labels: Readonly<Record<string, string>> | undefined, cloudboxName: string) =>
  labels?.cloudbox === cloudboxName;
const resourcePath = (name: string) => `/${name.split("/").map(encodeURIComponent).join("/")}`;

export interface GcpProjectServiceProps {
  readonly project: string;
  readonly service: string;
}
export type GcpProjectService = Resource<
  "GCP.ServiceUsage.ProjectService",
  GcpProjectServiceProps,
  { readonly serviceName: string },
  never,
  Providers
>;
export const GcpProjectService = Resource<GcpProjectService>("GCP.ServiceUsage.ProjectService");

export interface GcpProjectInfoProps {
  readonly project: string;
}
export type GcpProjectInfo = Resource<
  "GCP.ResourceManager.ProjectInfo",
  GcpProjectInfoProps,
  { readonly projectId: string; readonly projectNumber: string },
  never,
  Providers
>;
export const GcpProjectInfo = Resource<GcpProjectInfo>("GCP.ResourceManager.ProjectInfo");

export interface GcpStorageBucketProps {
  readonly project: string;
  readonly name: string;
  readonly location: string;
  readonly cloudboxName: string;
  readonly apiService: string;
}
export type GcpStorageBucket = Resource<
  "GCP.Storage.Bucket",
  GcpStorageBucketProps,
  { readonly bucketName: string; readonly location: string },
  never,
  Providers
>;
export const GcpStorageBucket = Resource<GcpStorageBucket>("GCP.Storage.Bucket");

export interface GcpStorageObjectProps {
  readonly bucketName: string;
  readonly objectName: string;
  readonly contentBase64: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly apiService: string;
}
export type GcpStorageObject = Resource<
  "GCP.Storage.Object",
  GcpStorageObjectProps,
  { readonly bucketName: string; readonly objectName: string; readonly generation: string | undefined },
  never,
  Providers
>;
export const GcpStorageObject = Resource<GcpStorageObject>("GCP.Storage.Object");

export interface GcpArtifactRepositoryProps {
  readonly project: string;
  readonly location: string;
  readonly repositoryId: string;
  readonly cloudboxName: string;
  readonly apiService: string;
}
export type GcpArtifactRepository = Resource<
  "GCP.ArtifactRegistry.Repository",
  GcpArtifactRepositoryProps,
  { readonly name: string; readonly repositoryId: string; readonly location: string },
  never,
  Providers
>;
export const GcpArtifactRepository = Resource<GcpArtifactRepository>("GCP.ArtifactRegistry.Repository");

export interface GcpCloudBuildProps {
  readonly project: string;
  readonly location: string;
  readonly bucketName: string;
  readonly objectName: string;
  readonly imageUri: string;
  readonly sourceSha256: string;
  readonly dependencies: ReadonlyArray<string>;
}
export type GcpCloudBuild = Resource<
  "GCP.CloudBuild.Build",
  GcpCloudBuildProps,
  { readonly buildId: string; readonly imageUri: string; readonly status: string },
  never,
  Providers
>;
export const GcpCloudBuild = Resource<GcpCloudBuild>("GCP.CloudBuild.Build");

export interface GcpSecretProps {
  readonly project: string;
  readonly secretId: string;
  readonly cloudboxName: string;
  readonly apiService: string;
}
export type GcpSecret = Resource<
  "GCP.SecretManager.Secret",
  GcpSecretProps,
  { readonly name: string; readonly secretId: string },
  never,
  Providers
>;
export const GcpSecret = Resource<GcpSecret>("GCP.SecretManager.Secret");

export interface GcpSecretVersionProps {
  readonly secretName: string;
  readonly value: Redacted.Redacted<string>;
  readonly apiService: string;
}
export type GcpSecretVersion = Resource<
  "GCP.SecretManager.SecretVersion",
  GcpSecretVersionProps,
  { readonly name: string; readonly version: string },
  never,
  Providers
>;
export const GcpSecretVersion = Resource<GcpSecretVersion>("GCP.SecretManager.SecretVersion");

export interface GcpCloudRunServiceProps extends CloudRunBodyInput {
  readonly location: string;
  readonly buildId: string;
  readonly runtimeBindings: ReadonlyArray<string>;
  readonly apiService: string;
}
export type GcpCloudRunService = Resource<
  "GCP.CloudRun.Service",
  GcpCloudRunServiceProps,
  { readonly name: string; readonly uri: string; readonly location: string },
  never,
  Providers
>;
export const GcpCloudRunService = Resource<GcpCloudRunService>("GCP.CloudRun.Service");

export type GcpIamTarget = "project" | "bucket" | "artifactRepository" | "secret" | "cloudRun";
export interface GcpResourceIamBindingProps {
  readonly target: GcpIamTarget;
  readonly resourceName: string;
  readonly member: string;
  readonly role: string;
  readonly apiService: string;
}
export type GcpResourceIamBinding = Resource<
  "GCP.IAM.ResourceBinding",
  GcpResourceIamBindingProps,
  { readonly target: GcpIamTarget; readonly resourceName: string; readonly member: string; readonly role: string },
  never,
  Providers
>;
export const GcpResourceIamBinding = Resource<GcpResourceIamBinding>("GCP.IAM.ResourceBinding");

export const GcpProjectServiceProvider = (api: GcpApi) =>
  Provider.succeed(GcpProjectService, {
    stables: ["serviceName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return same(olds, news) ? undefined : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const name = output?.serviceName ?? `projects/${olds.project}/services/${olds.service}`;
      const service = yield* api.requestOptional(`get API ${olds.service}`, resourcePath(name), ServiceUsageResponse, { baseUrl: SERVICE_USAGE_API });
      return service?.state === "ENABLED" ? { serviceName: service.name } : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const name = `projects/${news.project}/services/${news.service}`;
      let current = yield* api.requestOptional(`get API ${news.service}`, resourcePath(name), ServiceUsageResponse, { baseUrl: SERVICE_USAGE_API });
      if (current?.state !== "ENABLED") {
        const operation = yield* api.request(`enable API ${news.service}`, `${resourcePath(name)}:enable`, GoogleLongRunningOperation, { method: "POST", body: "{}", baseUrl: SERVICE_USAGE_API });
        yield* api.waitForGoogleOperation(operation, SERVICE_USAGE_API);
      }
      for (let poll = 0; poll < 90; poll += 1) {
        current = yield* api.request(`confirm API ${news.service} is enabled`, resourcePath(name), ServiceUsageResponse, { baseUrl: SERVICE_USAGE_API });
        if (current.state === "ENABLED") {
          return { serviceName: current.name };
        }
        yield* Effect.sleep(Duration.seconds(2));
      }
      return yield* Effect.fail(
        new GcpPlatformResourceError({
          resource: name,
          message: `${news.service} did not report ENABLED within 3 minutes`,
        }),
      );
    }),
    delete: () => Effect.void,
  });

const getProjectInfo = (api: GcpApi, project: string) =>
  api.request(
    `get project ${project}`,
    `/projects/${encodeURIComponent(project)}`,
    GcpProjectResponse,
    { baseUrl: CLOUD_RESOURCE_MANAGER_API },
  );

export const GcpProjectInfoProvider = (api: GcpApi) =>
  Provider.succeed(GcpProjectInfo, {
    stables: ["projectId", "projectNumber"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project
        ? undefined
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds }) {
      if (olds === undefined) return undefined;
      const project = yield* getProjectInfo(api, olds.project);
      return { projectId: project.projectId, projectNumber: project.projectNumber };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const project = yield* getProjectInfo(api, news.project);
      return { projectId: project.projectId, projectNumber: project.projectNumber };
    }),
    delete: () => Effect.void,
  });

const bucketPath = (name: string) => `/b/${encodeURIComponent(name)}`;
export const GcpStorageBucketProvider = (api: GcpApi) =>
  Provider.succeed(GcpStorageBucket, {
    stables: ["bucketName", "location"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project && olds.name === news.name && olds.location === news.location
        ? same(olds, news) ? undefined : { action: "update" } as const
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const name = output?.bucketName ?? olds.name;
      const bucket = yield* api.requestOptional(`get bucket ${name}`, bucketPath(name), BucketResponse, { baseUrl: STORAGE_API });
      if (bucket === undefined) return undefined;
      const attrs = { bucketName: bucket.name, location: bucket.location };
      return owned(bucket.labels, olds.cloudboxName) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      let bucket = yield* api.requestOptional(`get bucket ${news.name}`, bucketPath(news.name), BucketResponse, { baseUrl: STORAGE_API });
      if (bucket === undefined) {
        bucket = yield* api.request(`create bucket ${news.name}`, `/b?project=${encodeURIComponent(news.project)}`, BucketResponse, {
          method: "POST",
          body: JSON.stringify(buildStorageBucketBody(news.name, news.location, news.cloudboxName)),
          baseUrl: STORAGE_API,
        });
      }
      return { bucketName: bucket.name, location: bucket.location };
    }),
    delete: Effect.fn(function* ({ output }) {
      const objects = yield* api.request(
        `list objects in ${output.bucketName}`,
        `${bucketPath(output.bucketName)}/o?maxResults=1000`,
        StorageObjectListResponse,
        { baseUrl: STORAGE_API },
      ).pipe(
        Effect.catchTag("GcpApiError", (error) =>
          error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (objects === undefined) return;
      yield* Effect.forEach(objects.items ?? [], (object) =>
        api.request(
          `delete object ${object.name}`,
          `${bucketPath(output.bucketName)}/o/${encodeURIComponent(object.name)}`,
          EmptyResponse,
          { method: "DELETE", baseUrl: STORAGE_API },
        ).pipe(
          Effect.catchTag("GcpApiError", (error) =>
            error.status === 404 ? Effect.void : Effect.fail(error),
          ),
        ),
      );
      yield* api.request(`delete bucket ${output.bucketName}`, bucketPath(output.bucketName), EmptyResponse, { method: "DELETE", baseUrl: STORAGE_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.void : Effect.fail(error)),
      );
    }),
  });

const objectPath = (bucket: string, object: string) => `${bucketPath(bucket)}/o/${encodeURIComponent(object)}`;
export const GcpStorageObjectProvider = (api: GcpApi) =>
  Provider.succeed(GcpStorageObject, {
    stables: ["bucketName", "objectName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.bucketName === news.bucketName && olds.objectName === news.objectName && olds.sha256 === news.sha256
        ? undefined
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const bucket = output?.bucketName ?? olds?.bucketName;
      const object = output?.objectName ?? olds?.objectName;
      if (bucket === undefined || object === undefined) return undefined;
      const found = yield* api.requestOptional(`get object ${object}`, objectPath(bucket, object), StorageObjectResponse, { baseUrl: STORAGE_API });
      return found === undefined ? undefined : { bucketName: found.bucket, objectName: found.name, generation: found.generation };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const bytes = Buffer.from(news.contentBase64, "base64");
      const object = yield* api.request(
        `upload object ${news.objectName}`,
        `/b/${encodeURIComponent(news.bucketName)}/o?uploadType=media&name=${encodeURIComponent(news.objectName)}&ifGenerationMatch=0`,
        StorageObjectResponse,
        { method: "POST", body: bytes, headers: { "Content-Type": news.contentType }, baseUrl: STORAGE_UPLOAD_API },
      ).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 412
          ? api.request(`get object ${news.objectName}`, objectPath(news.bucketName, news.objectName), StorageObjectResponse, { baseUrl: STORAGE_API })
          : Effect.fail(error)),
      );
      return { bucketName: object.bucket, objectName: object.name, generation: object.generation };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(`delete object ${output.objectName}`, objectPath(output.bucketName, output.objectName), EmptyResponse, { method: "DELETE", baseUrl: STORAGE_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.void : Effect.fail(error)),
      );
    }),
  });

const repositoryName = (props: GcpArtifactRepositoryProps) =>
  `projects/${props.project}/locations/${props.location}/repositories/${props.repositoryId}`;
export const GcpArtifactRepositoryProvider = (api: GcpApi) =>
  Provider.succeed(GcpArtifactRepository, {
    stables: ["name", "repositoryId", "location"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project && olds.location === news.location && olds.repositoryId === news.repositoryId
        ? same(olds, news) ? undefined : { action: "update" } as const
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const name = output?.name ?? repositoryName(olds);
      const repo = yield* api.requestOptional(`get repository ${name}`, resourcePath(name), RepositoryResponse, { baseUrl: ARTIFACT_API });
      if (repo === undefined) return undefined;
      const attrs = { name: repo.name, repositoryId: olds.repositoryId, location: olds.location };
      return owned(repo.labels, olds.cloudboxName) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const name = repositoryName(news);
      let repo = yield* api.requestOptional(`get repository ${name}`, resourcePath(name), RepositoryResponse, { baseUrl: ARTIFACT_API });
      if (repo === undefined) {
        const operation = yield* api.request(
          `create repository ${news.repositoryId}`,
          `/projects/${encodeURIComponent(news.project)}/locations/${encodeURIComponent(news.location)}/repositories?repositoryId=${encodeURIComponent(news.repositoryId)}`,
          GoogleLongRunningOperation,
          { method: "POST", body: JSON.stringify(buildArtifactRepositoryBody(news.cloudboxName)), baseUrl: ARTIFACT_API },
        );
        yield* api.waitForGoogleOperation(operation, ARTIFACT_API);
        repo = yield* api.request(`get repository ${name}`, resourcePath(name), RepositoryResponse, { baseUrl: ARTIFACT_API });
      }
      return { name: repo.name, repositoryId: news.repositoryId, location: news.location };
    }),
    delete: Effect.fn(function* ({ output }) {
      const operation = yield* api.request(`delete repository ${output.name}`, resourcePath(output.name), GoogleLongRunningOperation, { method: "DELETE", baseUrl: ARTIFACT_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)),
      );
      if (operation !== undefined) yield* api.waitForGoogleOperation(operation, ARTIFACT_API);
    }),
  });

const buildPath = (project: string, location: string, id: string) =>
  `/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/builds/${encodeURIComponent(id)}`;
export const GcpCloudBuildProvider = (api: GcpApi) =>
  Provider.succeed(GcpCloudBuild, {
    stables: ["buildId", "imageUri"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project && olds.sourceSha256 === news.sourceSha256 && olds.imageUri === news.imageUri
        ? undefined
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined || output === undefined) return undefined;
      const build = yield* api.requestOptional(`get build ${output.buildId}`, buildPath(olds.project, olds.location, output.buildId), BuildResponse, { baseUrl: CLOUD_BUILD_API });
      return build?.status === "SUCCESS" ? { buildId: build.id, imageUri: output.imageUri, status: build.status } : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const operation = yield* api.request(
        "build wake service image",
        `/projects/${encodeURIComponent(news.project)}/locations/${encodeURIComponent(news.location)}/builds`,
        GoogleLongRunningOperation,
        { method: "POST", body: JSON.stringify(buildCloudBuildBody(news)), baseUrl: CLOUD_BUILD_API },
      );
      const completed = yield* api.waitForGoogleOperation(operation, CLOUD_BUILD_API);
      const build = yield* Schema.decodeUnknownEffect(BuildResponse)(completed.response).pipe(
        Effect.mapError(() =>
          new GcpPlatformResourceError({
            resource: completed.name,
            message: "Cloud Build operation returned no build response",
          }),
        ),
      );
      if (build.status !== "SUCCESS") {
        return yield* Effect.fail(new GcpPlatformResourceError({ resource: build.id, message: `Cloud Build ended in ${build.status}` }));
      }
      return { buildId: build.id, imageUri: news.imageUri, status: build.status };
    }),
    delete: () => Effect.void,
  });

const secretName = (project: string, id: string) => `projects/${project}/secrets/${id}`;
export const GcpSecretProvider = (api: GcpApi) =>
  Provider.succeed(GcpSecret, {
    stables: ["name", "secretId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project && olds.secretId === news.secretId
        ? same(olds, news) ? undefined : { action: "update" } as const
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const name = output?.name ?? secretName(olds.project, olds.secretId);
      const secret = yield* api.requestOptional(`get secret ${name}`, resourcePath(name), SecretResponse, { baseUrl: SECRET_MANAGER_API });
      if (secret === undefined) return undefined;
      const attrs = { name: secret.name, secretId: olds.secretId };
      return owned(secret.labels, olds.cloudboxName) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const name = secretName(news.project, news.secretId);
      let secret = yield* api.requestOptional(`get secret ${name}`, resourcePath(name), SecretResponse, { baseUrl: SECRET_MANAGER_API });
      if (secret === undefined) {
        secret = yield* api.request(
          `create secret ${news.secretId}`,
          `/projects/${encodeURIComponent(news.project)}/secrets?secretId=${encodeURIComponent(news.secretId)}`,
          SecretResponse,
          { method: "POST", body: JSON.stringify(buildSecretBody(news.cloudboxName)), baseUrl: SECRET_MANAGER_API },
        );
      }
      return { name: secret.name, secretId: news.secretId };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(`delete secret ${output.name}`, resourcePath(output.name), EmptyResponse, { method: "DELETE", baseUrl: SECRET_MANAGER_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.void : Effect.fail(error)),
      );
    }),
  });

export const GcpSecretVersionProvider = (api: GcpApi) =>
  Provider.succeed(GcpSecretVersion, {
    stables: ["name"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.secretName === news.secretName && same(olds.value, news.value)
        ? undefined
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const version = yield* api.requestOptional(`get secret version ${output.name}`, resourcePath(output.name), SecretVersionResponse, { baseUrl: SECRET_MANAGER_API });
      return version === undefined || version.state === "DESTROYED" ? undefined : output;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const version = yield* api.request(
        `add secret version ${news.secretName}`,
        `${resourcePath(news.secretName)}:addVersion`,
        SecretVersionResponse,
        {
          method: "POST",
          body: JSON.stringify({ payload: { data: Buffer.from(Redacted.value(news.value), "utf8").toString("base64") } }),
          baseUrl: SECRET_MANAGER_API,
        },
      );
      return { name: version.name, version: version.name.split("/").at(-1)! };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(`destroy secret version ${output.name}`, `${resourcePath(output.name)}:destroy`, SecretVersionResponse, { method: "POST", body: "{}", baseUrl: SECRET_MANAGER_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.void : Effect.fail(error)),
      );
    }),
  });

const cloudRunName = (props: GcpCloudRunServiceProps) =>
  `projects/${props.project}/locations/${props.location}/services/${props.serviceName}`;
export const GcpCloudRunServiceProvider = (api: GcpApi) =>
  Provider.succeed(GcpCloudRunService, {
    stables: ["name", "location"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project && olds.location === news.location && olds.serviceName === news.serviceName
        ? same(olds, news) ? undefined : { action: "update" } as const
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const name = output?.name ?? cloudRunName(olds);
      const service = yield* api.requestOptional(`get Cloud Run service ${name}`, resourcePath(name), CloudRunServiceResponse, { baseUrl: CLOUD_RUN_API });
      if (service === undefined) return undefined;
      const uri = service.uri ?? output?.uri;
      if (uri === undefined) return undefined;
      const attrs = { name: service.name, uri, location: olds.location };
      return owned(service.labels, olds.cloudboxName) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const name = cloudRunName(news);
      const body = buildCloudRunServiceBody(news);
      let service = yield* api.requestOptional(`get Cloud Run service ${name}`, resourcePath(name), CloudRunServiceResponse, { baseUrl: CLOUD_RUN_API });
      const operation = service === undefined
        ? yield* api.request(
            `create Cloud Run service ${news.serviceName}`,
            `/projects/${encodeURIComponent(news.project)}/locations/${encodeURIComponent(news.location)}/services?serviceId=${encodeURIComponent(news.serviceName)}`,
            GoogleLongRunningOperation,
            { method: "POST", body: JSON.stringify(body), baseUrl: CLOUD_RUN_API },
          )
        : yield* api.request(
            `update Cloud Run service ${news.serviceName}`,
            `${resourcePath(name)}?updateMask=labels,ingress,template`,
            GoogleLongRunningOperation,
            { method: "PATCH", body: JSON.stringify({ name, ...body }), baseUrl: CLOUD_RUN_API },
          );
      yield* api.waitForGoogleOperation(operation, CLOUD_RUN_API);
      service = yield* api.request(`get Cloud Run service ${name}`, resourcePath(name), CloudRunServiceResponse, { baseUrl: CLOUD_RUN_API });
      if (service.uri === undefined) {
        return yield* Effect.fail(new GcpPlatformResourceError({ resource: name, message: "Cloud Run returned no service URI" }));
      }
      return { name: service.name, uri: service.uri, location: news.location };
    }),
    delete: Effect.fn(function* ({ output }) {
      const operation = yield* api.request(`delete Cloud Run service ${output.name}`, resourcePath(output.name), GoogleLongRunningOperation, { method: "DELETE", baseUrl: CLOUD_RUN_API }).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)),
      );
      if (operation !== undefined) yield* api.waitForGoogleOperation(operation, CLOUD_RUN_API);
    }),
  });

const iamApi = (target: GcpIamTarget) =>
  target === "project"
    ? CLOUD_RESOURCE_MANAGER_API
    : target === "bucket"
      ? STORAGE_API
      : target === "artifactRepository"
        ? ARTIFACT_API
        : target === "secret"
          ? SECRET_MANAGER_API
          : CLOUD_RUN_API;
const getPolicy = (api: GcpApi, props: GcpResourceIamBindingProps) => {
  if (props.target === "bucket") {
    return api.request(`get IAM policy for ${props.resourceName}`, `${bucketPath(props.resourceName)}/iam`, IamPolicyResponse, { baseUrl: STORAGE_API });
  }
  return api.request(
    `get IAM policy for ${props.resourceName}`,
    `${resourcePath(props.resourceName)}:getIamPolicy`,
    IamPolicyResponse,
    props.target === "project"
      ? { method: "POST", body: "{}", baseUrl: CLOUD_RESOURCE_MANAGER_API }
      : { baseUrl: iamApi(props.target) },
  );
};
const setPolicy = (api: GcpApi, props: GcpResourceIamBindingProps, policy: IamPolicy) =>
  props.target === "bucket"
    ? api.request(`set IAM policy for ${props.resourceName}`, `${bucketPath(props.resourceName)}/iam`, IamPolicyResponse, { method: "PUT", body: JSON.stringify(policy), baseUrl: STORAGE_API })
    : api.request(`set IAM policy for ${props.resourceName}`, `${resourcePath(props.resourceName)}:setIamPolicy`, IamPolicyResponse, { method: "POST", body: JSON.stringify({ policy }), baseUrl: iamApi(props.target) });
const expectedResourceBinding = (props: GcpResourceIamBindingProps): IamPolicyBinding => ({ role: props.role, members: [props.member] });
const hasBinding = (policy: IamPolicy, expected: IamPolicyBinding) =>
  (policy.bindings ?? []).some((binding) => binding.role === expected.role && binding.condition === undefined && expected.members.every((member) => binding.members.includes(member)));

export const GcpResourceIamBindingProvider = (api: GcpApi) =>
  Provider.succeed(GcpResourceIamBinding, {
    stables: ["target", "resourceName", "member", "role"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return same(olds, news) ? undefined : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ olds }) {
      if (olds === undefined) return undefined;
      const policy = yield* getPolicy(api, olds).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)),
      );
      if (policy === undefined || !hasBinding(policy, expectedResourceBinding(olds))) return undefined;
      return { target: olds.target, resourceName: olds.resourceName, member: olds.member, role: olds.role };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const policy = yield* getPolicy(api, news);
      const expected = expectedResourceBinding(news);
      if (!hasBinding(policy, expected)) yield* setPolicy(api, news, buildIamPolicyWithBinding(policy, expected));
      return { target: news.target, resourceName: news.resourceName, member: news.member, role: news.role };
    }),
    delete: Effect.fn(function* ({ output }) {
      const props = output as GcpResourceIamBindingProps;
      const policy = yield* getPolicy(api, props).pipe(
        Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)),
      );
      if (policy === undefined) return;
      const bindings = (policy.bindings ?? []).flatMap((binding) => {
        if (binding.role !== props.role || binding.condition !== undefined) return [binding];
        const members = binding.members.filter((member) => member !== props.member);
        return members.length === 0 ? [] : [{ ...binding, members }];
      });
      if (!same(bindings, policy.bindings ?? [])) yield* setPolicy(api, props, { version: policy.version, ...(policy.etag === undefined ? {} : { etag: policy.etag }), bindings });
    }),
  });
