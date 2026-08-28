import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  buildCustomRoleBody,
  buildIamPolicyWithBinding,
  buildServiceAccountBody,
  type IamPolicy,
  type IamPolicyBinding,
} from "./bodies.ts";
import { GcpApi } from "./client.ts";
import type { Providers } from "./providers.ts";

const IAM_API = "https://iam.googleapis.com/v1";

const ServiceAccountResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  projectId: Schema.optional(Schema.String),
  uniqueId: Schema.optional(Schema.String),
  email: Schema.NonEmptyString,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});

const CustomRoleResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  includedPermissions: Schema.optional(Schema.Array(Schema.String)),
  stage: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
});

const ServiceAccountKeyResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  privateKeyData: Schema.optional(Schema.NonEmptyString),
  validAfterTime: Schema.optional(Schema.String),
  validBeforeTime: Schema.optional(Schema.String),
});

const IamCondition = Schema.Struct({
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  expression: Schema.NonEmptyString,
});
const IamBinding = Schema.Struct({
  role: Schema.NonEmptyString,
  members: Schema.Array(Schema.NonEmptyString),
  condition: Schema.optional(IamCondition),
});
const IamPolicyResponse = Schema.Struct({
  version: Schema.optional(Schema.Number),
  etag: Schema.optional(Schema.String),
  bindings: Schema.optional(Schema.Array(IamBinding)),
});
const InstanceOwnershipResponse = Schema.Struct({
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const EmptyResponse = Schema.Unknown;

export class GcpIamResourceError extends Data.TaggedError("GcpIamResourceError")<{
  readonly resource: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface GcpServiceAccountProps {
  readonly project: string;
  readonly accountId: string;
  readonly cloudboxName: string;
}

export type GcpServiceAccount = Resource<
  "GCP.IAM.ServiceAccount",
  GcpServiceAccountProps,
  { readonly name: string; readonly email: string },
  never,
  Providers
>;
export const GcpServiceAccount = Resource<GcpServiceAccount>("GCP.IAM.ServiceAccount");

export interface GcpCustomRoleProps {
  readonly project: string;
  readonly roleId: string;
  readonly cloudboxName: string;
}

export type GcpCustomRole = Resource<
  "GCP.IAM.CustomRole",
  GcpCustomRoleProps,
  { readonly name: string; readonly roleId: string },
  never,
  Providers
>;
export const GcpCustomRole = Resource<GcpCustomRole>("GCP.IAM.CustomRole");

export interface GcpServiceAccountKeyProps {
  readonly project: string;
  readonly serviceAccountEmail: string;
  readonly rotation: number;
}

export type GcpServiceAccountKey = Resource<
  "GCP.IAM.ServiceAccountKey",
  GcpServiceAccountKeyProps,
  {
    readonly name: string;
    readonly privateKeyJson: Redacted.Redacted<string>;
    readonly rotation: number;
  },
  never,
  Providers
>;
export const GcpServiceAccountKey = Resource<GcpServiceAccountKey>(
  "GCP.IAM.ServiceAccountKey",
);

export interface GcpIamBindingProps {
  readonly project: string;
  readonly zone: string;
  readonly instanceName: string;
  readonly cloudboxName: string;
  readonly serviceAccountEmail: string;
  readonly roleName: string;
}

export type GcpIamBinding = Resource<
  "GCP.Compute.InstanceIamBinding",
  GcpIamBindingProps,
  {
    readonly instanceName: string;
    readonly zone: string;
    readonly member: string;
    readonly roleName: string;
  },
  never,
  Providers
>;
export const GcpIamBinding = Resource<GcpIamBinding>("GCP.Compute.InstanceIamBinding");

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const serviceAccountPath = (project: string, email: string) =>
  `/projects/${encodeURIComponent(project)}/serviceAccounts/${encodeURIComponent(email)}`;
const customRolePath = (project: string, roleId: string) =>
  `/projects/${encodeURIComponent(project)}/roles/${encodeURIComponent(roleId)}`;
const instancePath = (api: GcpApi, zone: string, name: string) =>
  api.projectPath(`/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`);

const getInstancePolicy = (api: GcpApi, zone: string, instanceName: string) =>
  api.request(
    `get IAM policy for ${instanceName}`,
    `${instancePath(api, zone, instanceName)}/getIamPolicy?options.requestedPolicyVersion=3`,
    IamPolicyResponse,
  );

const setInstancePolicy = (
  api: GcpApi,
  zone: string,
  instanceName: string,
  policy: IamPolicy,
) =>
  api.request(
    `set IAM policy for ${instanceName}`,
    `${instancePath(api, zone, instanceName)}/setIamPolicy`,
    IamPolicyResponse,
    { method: "POST", body: JSON.stringify({ policy }) },
  );

const assertOwnedInstance = (
  api: GcpApi,
  zone: string,
  instanceName: string,
  cloudboxName: string,
) =>
  api
    .request(
      `verify owner label on ${instanceName}`,
      instancePath(api, zone, instanceName),
      InstanceOwnershipResponse,
    )
    .pipe(
      Effect.flatMap((instance) =>
        instance.labels?.cloudbox === cloudboxName
          ? Effect.void
          : Effect.fail(
              new GcpIamResourceError({
                resource: instanceName,
                message: `Refusing IAM binding: ${instanceName} is not labelled cloudbox=${cloudboxName}`,
              }),
            ),
      ),
    );

const expectedServiceAccount = (props: GcpServiceAccountProps) => {
  const body = buildServiceAccountBody(props);
  return body.serviceAccount;
};

export const GcpServiceAccountProvider = (api: GcpApi) =>
  Provider.succeed(GcpServiceAccount, {
    stables: ["name", "email"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      if (olds.project !== news.project || olds.accountId !== news.accountId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      return same(olds, news) ? undefined : { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const email = output?.email ?? (olds === undefined ? undefined : `${olds.accountId}@${olds.project}.iam.gserviceaccount.com`);
      if (email === undefined || olds === undefined) return undefined;
      const account = yield* api.requestOptional(
        `get service account ${email}`,
        serviceAccountPath(olds.project, email),
        ServiceAccountResponse,
        { baseUrl: IAM_API },
      );
      if (account === undefined) return undefined;
      const expected = expectedServiceAccount(olds);
      const attrs = { name: account.name, email: account.email };
      return account.displayName === expected.displayName && account.description === expected.description
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const email = `${news.accountId}@${news.project}.iam.gserviceaccount.com`;
      const body = buildServiceAccountBody(news);
      let account = yield* api.requestOptional(
        `get service account ${email}`,
        serviceAccountPath(news.project, email),
        ServiceAccountResponse,
        { baseUrl: IAM_API },
      );
      if (account === undefined) {
        account = yield* api.request(
          `create service account ${email}`,
          `/projects/${encodeURIComponent(news.project)}/serviceAccounts`,
          ServiceAccountResponse,
          { method: "POST", body: JSON.stringify(body), baseUrl: IAM_API },
        );
      } else if (
        account.displayName !== body.serviceAccount.displayName ||
        account.description !== body.serviceAccount.description
      ) {
        account = yield* api.request(
          `update service account ${email}`,
          serviceAccountPath(news.project, email),
          ServiceAccountResponse,
          {
            method: "PATCH",
            body: JSON.stringify({
              serviceAccount: { name: account.name, ...body.serviceAccount },
              updateMask: "displayName,description",
            }),
            baseUrl: IAM_API,
          },
        );
      }
      return { name: account.name, email: account.email };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(
        `delete service account ${output.email}`,
        `/${output.name.split("/").map(encodeURIComponent).join("/")}`,
        EmptyResponse,
        { method: "DELETE", baseUrl: IAM_API },
      ).pipe(
        Effect.catchTag("GcpApiError", (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

export const GcpCustomRoleProvider = (api: GcpApi) =>
  Provider.succeed(GcpCustomRole, {
    stables: ["name", "roleId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      if (olds.project !== news.project || olds.roleId !== news.roleId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      return same(olds, news) ? undefined : { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      const role = yield* api.requestOptional(
        `get custom role ${olds.roleId}`,
        customRolePath(olds.project, olds.roleId),
        CustomRoleResponse,
        { baseUrl: IAM_API },
      );
      if (role === undefined || role.deleted === true) return undefined;
      const expected = buildCustomRoleBody(olds);
      const attrs = { name: role.name, roleId: output?.roleId ?? olds.roleId };
      return role.title === expected.title &&
        role.description === expected.description &&
        same(role.includedPermissions ?? [], expected.includedPermissions)
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const body = buildCustomRoleBody(news);
      let role = yield* api.requestOptional(
        `get custom role ${news.roleId}`,
        customRolePath(news.project, news.roleId),
        CustomRoleResponse,
        { baseUrl: IAM_API },
      );
      if (role?.deleted === true) {
        role = yield* api.request(
          `undelete custom role ${news.roleId}`,
          `${customRolePath(news.project, news.roleId)}:undelete`,
          CustomRoleResponse,
          { method: "POST", body: "{}", baseUrl: IAM_API },
        );
      }
      if (role === undefined) {
        role = yield* api.request(
          `create custom role ${news.roleId}`,
          `/projects/${encodeURIComponent(news.project)}/roles`,
          CustomRoleResponse,
          {
            method: "POST",
            body: JSON.stringify({ roleId: news.roleId, role: body }),
            baseUrl: IAM_API,
          },
        );
      } else if (
        role.title !== body.title ||
        role.description !== body.description ||
        !same(role.includedPermissions ?? [], body.includedPermissions)
      ) {
        role = yield* api.request(
          `update custom role ${news.roleId}`,
          `${customRolePath(news.project, news.roleId)}?updateMask=title,description,includedPermissions,stage`,
          CustomRoleResponse,
          {
            method: "PATCH",
            body: JSON.stringify({ name: role.name, ...body }),
            baseUrl: IAM_API,
          },
        );
      }
      return { name: role.name, roleId: news.roleId };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(
        `delete custom role ${output.roleId}`,
        `/${output.name.split("/").map(encodeURIComponent).join("/")}`,
        CustomRoleResponse,
        { method: "DELETE", baseUrl: IAM_API },
      ).pipe(
        Effect.catchTag("GcpApiError", (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

export const GcpServiceAccountKeyProvider = (api: GcpApi) =>
  Provider.succeed(GcpServiceAccountKey, {
    stables: ["name"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return olds.project === news.project &&
        olds.serviceAccountEmail === news.serviceAccountEmail &&
        olds.rotation === news.rotation
        ? undefined
        : { action: "replace", deleteFirst: false } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const key = yield* api.requestOptional(
        `get service account key ${output.name}`,
        `/${output.name.split("/").map(encodeURIComponent).join("/")}`,
        ServiceAccountKeyResponse,
        { baseUrl: IAM_API },
      );
      return key === undefined ? undefined : output;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      if (output !== undefined) return output;
      const key = yield* api.request(
        `create key for ${news.serviceAccountEmail}`,
        `${serviceAccountPath(news.project, news.serviceAccountEmail)}/keys`,
        ServiceAccountKeyResponse,
        {
          method: "POST",
          body: JSON.stringify({
            privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
            keyAlgorithm: "KEY_ALG_RSA_2048",
          }),
          baseUrl: IAM_API,
        },
      );
      if (key.privateKeyData === undefined) {
        return yield* Effect.fail(
          new GcpIamResourceError({
            resource: key.name,
            message: "Google IAM created a service-account key without returning privateKeyData",
          }),
        );
      }
      let privateKeyJson: string;
      try {
        privateKeyJson = Buffer.from(key.privateKeyData, "base64").toString("utf8");
        JSON.parse(privateKeyJson);
      } catch (cause) {
        return yield* Effect.fail(
          new GcpIamResourceError({
            resource: key.name,
            message: "Google IAM returned invalid service-account key JSON",
            cause,
          }),
        );
      }
      return {
        name: key.name,
        privateKeyJson: Redacted.make(privateKeyJson),
        rotation: news.rotation,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* api.request(
        `delete service account key ${output.name}`,
        `/${output.name.split("/").map(encodeURIComponent).join("/")}`,
        EmptyResponse,
        { method: "DELETE", baseUrl: IAM_API },
      ).pipe(
        Effect.catchTag("GcpApiError", (error) =>
          error.status === 404 ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

const expectedBinding = (props: GcpIamBindingProps): IamPolicyBinding => ({
  role: props.roleName,
  members: [`serviceAccount:${props.serviceAccountEmail}`],
});

const hasExpectedBinding = (policy: IamPolicy, binding: IamPolicyBinding) =>
  (policy.bindings ?? []).some(
    (current) =>
      current.role === binding.role &&
      current.condition === undefined &&
      binding.members.every((member) => current.members.includes(member)),
  );

export const GcpIamBindingProvider = (api: GcpApi) =>
  Provider.succeed(GcpIamBinding, {
    stables: ["instanceName", "zone", "member", "roleName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      const identityChanged =
        olds.project !== news.project ||
        olds.zone !== news.zone ||
        olds.instanceName !== news.instanceName ||
        olds.serviceAccountEmail !== news.serviceAccountEmail ||
        olds.roleName !== news.roleName;
      return identityChanged
        ? ({ action: "replace", deleteFirst: false } as const)
        : same(olds, news)
          ? undefined
          : ({ action: "update" } as const);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (olds === undefined) return undefined;
      yield* assertOwnedInstance(api, olds.zone, olds.instanceName, olds.cloudboxName);
      const policy = yield* getInstancePolicy(api, olds.zone, olds.instanceName);
      const binding = expectedBinding(olds);
      if (!hasExpectedBinding(policy, binding)) return undefined;
      return {
        instanceName: olds.instanceName,
        zone: olds.zone,
        member: output?.member ?? binding.members[0]!,
        roleName: olds.roleName,
      };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      yield* assertOwnedInstance(api, news.zone, news.instanceName, news.cloudboxName);
      const current = yield* getInstancePolicy(api, news.zone, news.instanceName);
      const binding = expectedBinding(news);
      if (!hasExpectedBinding(current, binding)) {
        yield* setInstancePolicy(
          api,
          news.zone,
          news.instanceName,
          buildIamPolicyWithBinding(current, binding),
        );
      }
      return {
        instanceName: news.instanceName,
        zone: news.zone,
        member: binding.members[0]!,
        roleName: news.roleName,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const current = yield* getInstancePolicy(api, output.zone, output.instanceName).pipe(
        Effect.catchTag("GcpApiError", (error) =>
          error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (current === undefined) return;
      const bindings = (current.bindings ?? []).flatMap((binding) => {
        if (binding.role !== output.roleName || binding.condition !== undefined) return [binding];
        const members = binding.members.filter((member) => member !== output.member);
        return members.length === 0 ? [] : [{ ...binding, members }];
      });
      if (!same(bindings, current.bindings ?? [])) {
        yield* setInstancePolicy(api, output.zone, output.instanceName, {
          version: current.version,
          ...(current.etag === undefined ? {} : { etag: current.etag }),
          bindings,
        });
      }
      void olds;
    }),
  });
