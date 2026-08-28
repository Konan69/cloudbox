import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";

import type { GcpCredentials } from "../config.ts";
import { GcpApi } from "./client.ts";
import {
  GcpCustomRole,
  GcpCustomRoleProvider,
  GcpIamBinding,
  GcpIamBindingProvider,
  GcpServiceAccount,
  GcpServiceAccountProvider,
} from "./iam.ts";
import {
  GcpArtifactRepository,
  GcpArtifactRepositoryProvider,
  GcpCloudBuild,
  GcpCloudBuildProvider,
  GcpCloudRunService,
  GcpCloudRunServiceProvider,
  GcpProjectInfo,
  GcpProjectInfoProvider,
  GcpProjectService,
  GcpProjectServiceProvider,
  GcpResourceIamBinding,
  GcpResourceIamBindingProvider,
  GcpSecret,
  GcpSecretProvider,
  GcpSecretVersion,
  GcpSecretVersionProvider,
  GcpStorageBucket,
  GcpStorageBucketProvider,
  GcpStorageObject,
  GcpStorageObjectProvider,
} from "./platform.ts";
import {
  GcpDisk,
  GcpDiskProvider,
  GcpFirewallRule,
  GcpFirewallRuleProvider,
  GcpInstance,
  GcpInstanceProvider,
} from "./resources.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("GCP") {}

export interface GcpProviderOptions {
  readonly project: string;
  readonly credentials: GcpCredentials;
}

export const providers = (options: GcpProviderOptions) => {
  const api = new GcpApi(options);
  return Layer.effect(
    Providers,
    Provider.collection([
      GcpFirewallRule,
      GcpDisk,
      GcpInstance,
      GcpServiceAccount,
      GcpCustomRole,
      GcpIamBinding,
      GcpProjectService,
      GcpProjectInfo,
      GcpStorageBucket,
      GcpStorageObject,
      GcpArtifactRepository,
      GcpCloudBuild,
      GcpSecret,
      GcpSecretVersion,
      GcpCloudRunService,
      GcpResourceIamBinding,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        GcpFirewallRuleProvider(api),
        GcpDiskProvider(api),
        GcpInstanceProvider(api),
        GcpServiceAccountProvider(api),
        GcpCustomRoleProvider(api),
        GcpIamBindingProvider(api),
        GcpProjectServiceProvider(api),
        GcpProjectInfoProvider(api),
        GcpStorageBucketProvider(api),
        GcpStorageObjectProvider(api),
        GcpArtifactRepositoryProvider(api),
        GcpCloudBuildProvider(api),
        GcpSecretProvider(api),
        GcpSecretVersionProvider(api),
        GcpCloudRunServiceProvider(api),
        GcpResourceIamBindingProvider(api),
      ),
    ),
  );
};
