import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildDiskInsertBody, buildFirewallRuleBody, buildInstanceInsertBody } from "./bodies.ts";
import { GcpApi, Operation } from "./client.ts";
import type { Providers } from "./providers.ts";

const CloudboxLabel = Schema.Struct({ cloudbox: Schema.optional(Schema.String) });

const FirewallResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  selfLink: Schema.optional(Schema.String),
});

const DiskResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  zone: Schema.NonEmptyString,
  sizeGb: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  selfLink: Schema.optional(Schema.String),
  labelFingerprint: Schema.optional(Schema.String),
  labels: Schema.optional(CloudboxLabel),
});

const InstanceResponse = Schema.Struct({
  name: Schema.NonEmptyString,
  zone: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  machineType: Schema.NonEmptyString,
  labelFingerprint: Schema.optional(Schema.String),
  labels: Schema.optional(CloudboxLabel),
  tags: Schema.optional(
    Schema.Struct({
      fingerprint: Schema.optional(Schema.String),
      items: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      fingerprint: Schema.optional(Schema.String),
      items: Schema.optional(
        Schema.Array(
          Schema.Struct({ key: Schema.NonEmptyString, value: Schema.optional(Schema.String) }),
        ),
      ),
    }),
  ),
  disks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        boot: Schema.optional(Schema.Boolean),
        deviceName: Schema.optional(Schema.String),
        source: Schema.optional(Schema.String),
      }),
    ),
  ),
  networkInterfaces: Schema.optional(
    Schema.Array(
      Schema.Struct({
        accessConfigs: Schema.optional(
          Schema.Array(Schema.Struct({ natIP: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

type FirewallResponse = typeof FirewallResponse.Type;
type DiskResponse = typeof DiskResponse.Type;
type InstanceResponse = typeof InstanceResponse.Type;

export class GcpResourceError extends Data.TaggedError("GcpResourceError")<{
  readonly resource: string;
  readonly message: string;
}> {}

export interface GcpFirewallRuleProps {
  readonly project: string;
  readonly name: string;
  readonly sshCidr: string;
  readonly targetTag: string;
  readonly cloudboxName: string;
}

export type GcpFirewallRule = Resource<
  "GCP.Compute.FirewallRule",
  GcpFirewallRuleProps,
  {
    readonly firewallRuleName: string;
    readonly targetTag: string;
  },
  never,
  Providers
>;

export const GcpFirewallRule = Resource<GcpFirewallRule>("GCP.Compute.FirewallRule");

export interface GcpDiskProps {
  readonly project: string;
  readonly zone: string;
  readonly name: string;
  readonly sizeGb: number;
  readonly type: "pd-ssd" | "pd-balanced";
  readonly cloudboxName: string;
}

export type GcpDisk = Resource<
  "GCP.Compute.Disk",
  GcpDiskProps,
  {
    readonly dataDiskName: string;
    readonly zone: string;
    readonly sizeGb: number;
    readonly type: "pd-ssd" | "pd-balanced";
  },
  never,
  Providers
>;

export const GcpDisk = Resource<GcpDisk>("GCP.Compute.Disk");

export interface GcpInstanceProps {
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

export type GcpInstance = Resource<
  "GCP.Compute.Instance",
  GcpInstanceProps,
  {
    readonly instanceName: string;
    readonly zone: string;
    readonly externalIp: string | undefined;
    readonly dataDiskName: string;
    readonly status: string;
  },
  never,
  Providers
>;

export const GcpInstance = Resource<GcpInstance>("GCP.Compute.Instance");

const lastPathPart = (value: string): string => value.split("/").at(-1) ?? value;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const firewallAttrs = (firewall: FirewallResponse, targetTag: string) => ({
  firewallRuleName: firewall.name,
  targetTag,
});

const diskAttrs = (disk: DiskResponse) => ({
  dataDiskName: disk.name,
  zone: lastPathPart(disk.zone),
  sizeGb: Number(disk.sizeGb),
  type: lastPathPart(disk.type) as "pd-ssd" | "pd-balanced",
});

const instanceAttrs = (instance: InstanceResponse, dataDiskName: string) => ({
  instanceName: instance.name,
  zone: lastPathPart(instance.zone),
  externalIp: instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
  dataDiskName,
  status: instance.status,
});

const firewallPath = (api: GcpApi, name: string) =>
  api.projectPath(`/global/firewalls/${encodeURIComponent(name)}`);
const diskPath = (api: GcpApi, zone: string, name: string) =>
  api.projectPath(`/zones/${encodeURIComponent(zone)}/disks/${encodeURIComponent(name)}`);
const instancePath = (api: GcpApi, zone: string, name: string) =>
  api.projectPath(`/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(name)}`);

const getFirewall = (api: GcpApi, name: string) =>
  api.requestOptional(`get firewall ${name}`, firewallPath(api, name), FirewallResponse);
const getDisk = (api: GcpApi, zone: string, name: string) =>
  api.requestOptional(`get disk ${name}`, diskPath(api, zone, name), DiskResponse);
export const getInstance = (api: GcpApi, zone: string, name: string) =>
  api.requestOptional(`get instance ${name}`, instancePath(api, zone, name), InstanceResponse);

const runZonal = (api: GcpApi, operation: Operation, zone: string) =>
  api.waitForOperation(operation, { zone });
const runGlobal = (api: GcpApi, operation: Operation) => api.waitForOperation(operation, "global");

export const GcpFirewallRuleProvider = (api: GcpApi) =>
  Provider.succeed(GcpFirewallRule, {
    stables: ["firewallRuleName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      return same(olds, news) ? undefined : { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.firewallRuleName ?? olds?.name;
      if (name === undefined) return undefined;
      const firewall = yield* getFirewall(api, name);
      if (firewall === undefined) return undefined;
      const attrs = firewallAttrs(firewall, olds?.targetTag ?? output?.targetTag ?? "");
      return firewall.description === `SSH access for cloudbox ${olds?.cloudboxName ?? ""}`
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const body = buildFirewallRuleBody(news);
      const current = yield* getFirewall(api, news.name);
      if (current === undefined) {
        const operation = yield* api.request(
          `create firewall ${news.name}`,
          api.projectPath("/global/firewalls"),
          Operation,
          { method: "POST", body: JSON.stringify(body) },
        );
        yield* runGlobal(api, operation);
      } else {
        const operation = yield* api.request(
          `update firewall ${news.name}`,
          firewallPath(api, news.name),
          Operation,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        yield* runGlobal(api, operation);
      }
      const fresh = yield* getFirewall(api, news.name);
      return fresh === undefined ? firewallAttrs({ name: news.name, description: body.description }, news.targetTag) : firewallAttrs(fresh, news.targetTag);
    }),
    delete: Effect.fn(function* ({ output }) {
      const operation = yield* api.request(
        `delete firewall ${output.firewallRuleName}`,
        firewallPath(api, output.firewallRuleName),
        Operation,
        { method: "DELETE" },
      ).pipe(Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)));
      if (operation !== undefined) yield* runGlobal(api, operation);
    }),
  });

export const GcpDiskProvider = (api: GcpApi) =>
  Provider.succeed(GcpDisk, {
    stables: ["dataDiskName", "zone"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      if (olds.project !== news.project || olds.zone !== news.zone || olds.name !== news.name) {
        return { action: "replace", deleteFirst: olds.name === news.name } as const;
      }
      return same(olds, news) ? undefined : { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.dataDiskName ?? olds?.name;
      const zone = output?.zone ?? olds?.zone;
      if (name === undefined || zone === undefined) return undefined;
      const disk = yield* getDisk(api, zone, name);
      if (disk === undefined) return undefined;
      const attrs = diskAttrs(disk);
      return disk.labels?.cloudbox === olds?.cloudboxName ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      let current = yield* getDisk(api, news.zone, news.name);
      if (current === undefined) {
        const operation = yield* api.request(
          `create disk ${news.name}`,
          api.projectPath(`/zones/${encodeURIComponent(news.zone)}/disks`),
          Operation,
          { method: "POST", body: JSON.stringify(buildDiskInsertBody(news)) },
        );
        yield* runZonal(api, operation, news.zone);
        current = yield* getDisk(api, news.zone, news.name);
      }
      if (current === undefined) {
        return yield* Effect.fail(
          new GcpResourceError({
            resource: news.name,
            message: `GCP disk ${news.name} was not found after creation`,
          }),
        );
      }
      if (Number(current.sizeGb) > news.sizeGb) {
        return yield* Effect.fail(
          new GcpResourceError({
            resource: news.name,
            message: `GCP disks cannot shrink from ${current.sizeGb} GB to ${String(news.sizeGb)} GB`,
          }),
        );
      }
      if (Number(current.sizeGb) < news.sizeGb) {
        const operation = yield* api.request(
          `resize disk ${news.name}`,
          `${diskPath(api, news.zone, news.name)}/resize`,
          Operation,
          { method: "POST", body: JSON.stringify({ sizeGb: String(news.sizeGb) }) },
        );
        yield* runZonal(api, operation, news.zone);
      }
      if (lastPathPart(current.type) !== news.type) {
        const operation = yield* api.request(
          `change disk type ${news.name}`,
          `${diskPath(api, news.zone, news.name)}/update?updateMask=type`,
          Operation,
          {
            method: "POST",
            body: JSON.stringify({ type: `projects/${news.project}/zones/${news.zone}/diskTypes/${news.type}` }),
          },
        );
        yield* runZonal(api, operation, news.zone);
      }
      if (current.labels?.cloudbox !== news.cloudboxName) {
        const operation = yield* api.request(
          `label disk ${news.name}`,
          `${diskPath(api, news.zone, news.name)}/setLabels`,
          Operation,
          {
            method: "POST",
            body: JSON.stringify({ labels: { cloudbox: news.cloudboxName }, labelFingerprint: current.labelFingerprint }),
          },
        );
        yield* runZonal(api, operation, news.zone);
      }
      const fresh = yield* getDisk(api, news.zone, news.name);
      return fresh === undefined
        ? { dataDiskName: news.name, zone: news.zone, sizeGb: news.sizeGb, type: news.type }
        : diskAttrs(fresh);
    }),
    delete: Effect.fn(function* ({ output }) {
      const operation = yield* api.request(
        `delete disk ${output.dataDiskName}`,
        diskPath(api, output.zone, output.dataDiskName),
        Operation,
        { method: "DELETE" },
      ).pipe(Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)));
      if (operation !== undefined) yield* runZonal(api, operation, output.zone);
    }),
  });

const desiredMetadata = (props: GcpInstanceProps) => [
  { key: "startup-script", value: props.startupScript },
  { key: "ssh-keys", value: `dev:${props.sshPublicKey.trim()}` },
];

export const GcpInstanceProvider = (api: GcpApi) =>
  Provider.succeed(GcpInstance, {
    stables: ["instanceName", "zone", "dataDiskName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return { action: "update" } as const;
      const replace =
        olds.project !== news.project ||
        olds.zone !== news.zone ||
        olds.name !== news.name ||
        olds.machineType !== news.machineType ||
        olds.bootDiskGb !== news.bootDiskGb ||
        olds.dataDiskName !== news.dataDiskName;
      if (replace) return { action: "replace", deleteFirst: olds.name === news.name } as const;
      return same(olds, news) ? undefined : { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.instanceName ?? olds?.name;
      const zone = output?.zone ?? olds?.zone;
      if (name === undefined || zone === undefined) return undefined;
      const instance = yield* getInstance(api, zone, name);
      if (instance === undefined) return undefined;
      const dataDiskName = olds?.dataDiskName ?? output?.dataDiskName ?? "";
      const attrs = instanceAttrs(instance, dataDiskName);
      return instance.labels?.cloudbox === olds?.cloudboxName ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      let current = yield* getInstance(api, news.zone, news.name);
      if (current === undefined) {
        const operation = yield* api.request(
          `create instance ${news.name}`,
          api.projectPath(`/zones/${encodeURIComponent(news.zone)}/instances`),
          Operation,
          { method: "POST", body: JSON.stringify(buildInstanceInsertBody(news)) },
        );
        yield* runZonal(api, operation, news.zone);
        current = yield* getInstance(api, news.zone, news.name);
      }
      if (current === undefined) {
        return yield* Effect.fail(
          new GcpResourceError({
            resource: news.name,
            message: `GCP instance ${news.name} was not found after creation`,
          }),
        );
      }

      const metadata = desiredMetadata(news);
      if (!same(current.metadata?.items ?? [], metadata)) {
        const operation = yield* api.request(
          `set metadata on ${news.name}`,
          `${instancePath(api, news.zone, news.name)}/setMetadata`,
          Operation,
          { method: "POST", body: JSON.stringify({ fingerprint: current.metadata?.fingerprint, items: metadata }) },
        );
        yield* runZonal(api, operation, news.zone);
      }
      if (!same(current.tags?.items ?? [], [news.networkTag])) {
        const operation = yield* api.request(
          `set tags on ${news.name}`,
          `${instancePath(api, news.zone, news.name)}/setTags`,
          Operation,
          { method: "POST", body: JSON.stringify({ fingerprint: current.tags?.fingerprint, items: [news.networkTag] }) },
        );
        yield* runZonal(api, operation, news.zone);
      }
      if (current.labels?.cloudbox !== news.cloudboxName) {
        const operation = yield* api.request(
          `label instance ${news.name}`,
          `${instancePath(api, news.zone, news.name)}/setLabels`,
          Operation,
          { method: "POST", body: JSON.stringify({ labelFingerprint: current.labelFingerprint, labels: { cloudbox: news.cloudboxName } }) },
        );
        yield* runZonal(api, operation, news.zone);
      }
      const fresh = yield* getInstance(api, news.zone, news.name);
      return instanceAttrs(fresh ?? current, news.dataDiskName);
    }),
    delete: Effect.fn(function* ({ output }) {
      const operation = yield* api.request(
        `delete instance ${output.instanceName}`,
        instancePath(api, output.zone, output.instanceName),
        Operation,
        { method: "DELETE" },
      ).pipe(Effect.catchTag("GcpApiError", (error) => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)));
      if (operation !== undefined) yield* runZonal(api, operation, output.zone);
    }),
  });
