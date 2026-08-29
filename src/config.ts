import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { isWakeAllowedOrigin } from "./wake/origin.ts";

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const isIpv4Cidr = (value: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(value);
  if (match === null) return false;
  return match.slice(1, 5).every((octet) => Number(octet) <= 255);
};

export const SshCidr = Schema.String.pipe(
  Schema.refine(
    (value): value is string => isIpv4Cidr(value) && value !== "0.0.0.0/0",
    {
      identifier: "SshCidr",
      description: "a valid IPv4 CIDR other than 0.0.0.0/0",
    },
  ),
);

export const T3SettingsParityConfig = Schema.Struct({
  enabled: Schema.Boolean,
  keybindings: Schema.Boolean,
});

export const T3Config = Schema.Struct({
  repoUrl: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  settingsParity: T3SettingsParityConfig,
});

const hasNoControlCharacters = (value: string): boolean => !/[\u0000-\u001f\u007f]/u.test(value);

const isGitCloneUrl = (value: string): boolean => {
  if (!hasNoControlCharacters(value)) return false;
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "ssh:") &&
        url.hostname.length > 0 &&
        url.pathname.length > 1
      );
    } catch {
      return false;
    }
  }
  if (value.includes("://")) return false;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const host = value.slice(0, separator);
  return !host.includes("/") && !host.includes("\\") && !/\s/u.test(host);
};

export const RepoUrl = Schema.String.pipe(
  Schema.refine((value): value is string => isGitCloneUrl(value), {
    identifier: "RepoUrl",
    description: "a git-cloneable HTTPS or SSH URL",
  }),
);

export const RepoPath = Schema.String.pipe(
  Schema.refine(
    (value): value is string => {
      if (!value.startsWith("~/") || !hasNoControlCharacters(value)) return false;
      const components = value.slice(2).split("/");
      return (
        components.length > 0 &&
        components.every(
          (component) => component.length > 0 && component !== "." && component !== "..",
        )
      );
    },
    {
      identifier: "RepoPath",
      description: "a repository path under the box user home, starting with ~/",
    },
  ),
);

const isGitBranchName = (value: string): boolean => {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    !hasNoControlCharacters(value) ||
    /[ ~^:?*[\\]/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
};

export const RepoBranch = Schema.String.pipe(
  Schema.refine((value): value is string => isGitBranchName(value), {
    identifier: "RepoBranch",
    description: "a valid Git branch name",
  }),
);

export const RepoConfig = Schema.Struct({
  url: RepoUrl,
  path: RepoPath,
  branch: Schema.optionalKey(RepoBranch),
});

export const ReposConfig = Schema.Array(RepoConfig).pipe(
  Schema.refine(
    (repos): repos is typeof repos =>
      new Set(repos.map((repo) => repo.path)).size === repos.length,
    {
      identifier: "ReposConfig",
      description: "repositories with unique paths",
    },
  ),
);

export const IdentityPath = Schema.String.pipe(
  Schema.refine((value): value is string => value.startsWith("~/"), {
    identifier: "IdentityPath",
    description: "a path relative to the local and remote user home, starting with ~/",
  }),
);

export const IdentityConfig = Schema.Struct({
  paths: Schema.Array(IdentityPath),
  excludes: Schema.Array(Schema.NonEmptyString),
  maxTransferMb: PositiveInteger,
});

export const GcpCredentials = Schema.Union([
  Schema.Literal("adc"),
  Schema.Struct({ serviceAccountJsonPath: Schema.NonEmptyString }),
]);

export const GcpMachineType = Schema.NonEmptyString.pipe(
  Schema.refine((value): value is string => /^(?:n1|n2|c2)-/.test(value), {
    identifier: "GcpMachineType",
    description: "an Intel Compute Engine N1, N2, or C2 machine type",
  }),
);

const GcpCloudboxName = Schema.String.pipe(
  Schema.refine(
    (value): value is string => /^[a-z0-9](?:[-a-z0-9]{0,48}[a-z0-9])?$/.test(value),
    {
      identifier: "GcpCloudboxName",
      description: "1-50 lowercase letters, digits, or hyphens, starting and ending alphanumeric",
    },
  ),
);

export const GcpConfig = Schema.Struct({
  project: Schema.NonEmptyString,
  zone: Schema.NonEmptyString,
  machineType: GcpMachineType,
  bootDiskGb: PositiveInteger,
  dataDiskGb: PositiveInteger,
  dataDiskType: Schema.Literals(["pd-ssd", "pd-balanced"]),
  credentials: GcpCredentials,
});

export const WakeAllowedOrigin = Schema.String.pipe(
  Schema.refine((value): value is string => isWakeAllowedOrigin(value), {
    identifier: "WakeAllowedOrigin",
    description: "an origin with a scheme and host, and no path",
  }),
);

export const WakeConfig = Schema.Struct({
  allowedOrigins: Schema.Array(WakeAllowedOrigin).pipe(
    Schema.refine(
      (origins): origins is ReadonlyArray<string> => origins.length > 0,
      {
        identifier: "WakeAllowedOrigins",
        description: "a non-empty list of allowed wake service origins",
      },
    ),
  ),
});

export const AwsConfig = Schema.Struct({
  sshCidr: SshCidr,
});

const SharedConfig = {
  name: Schema.NonEmptyString,
  sshPublicKeyPath: Schema.NonEmptyString,
  idleMinutes: PositiveInteger,
  t3: T3Config,
  identity: IdentityConfig,
  repos: ReposConfig,
  boxUser: Schema.Literal("dev"),
} as const;

export const AwsCloudboxConfig = Schema.Struct({
  ...SharedConfig,
  provider: Schema.Literal("aws"),
  aws: AwsConfig,
  region: Schema.NonEmptyString,
  instanceType: Schema.NonEmptyString,
  diskGb: PositiveInteger,
});

export const GcpCloudboxConfig = Schema.Struct({
  ...SharedConfig,
  name: GcpCloudboxName,
  provider: Schema.Literal("gcp"),
  gcp: GcpConfig,
  wake: WakeConfig,
});

export const CloudboxConfig = Schema.Union([AwsCloudboxConfig, GcpCloudboxConfig]);

export type RepoConfig = typeof RepoConfig.Type;
export type GcpCredentials = typeof GcpCredentials.Type;
export type GcpHostConfig = typeof GcpConfig.Type;
export type AwsCloudboxConfig = typeof AwsCloudboxConfig.Type;
export type GcpCloudboxConfig = typeof GcpCloudboxConfig.Type;
export type CloudboxConfig = typeof CloudboxConfig.Type;

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudboxConfig),
  { errors: "all", onExcessProperty: "error" },
);

const rejectLegacySshCidr = (path: string, contents: string) =>
  Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (cause) =>
      new ConfigError({
        path,
        message: `Invalid ${path}: config is not valid JSON`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((value) => {
      if (
        value !== null &&
        typeof value === "object" &&
        Object.prototype.hasOwnProperty.call(value, "sshCidr")
      ) {
        return Effect.fail(
          new ConfigError({
            path,
            message: `Invalid ${path}: top-level sshCidr was removed; use aws.sshCidr for AWS. GCP configs do not accept an SSH CIDR.`,
            cause: value,
          }),
        );
      }
      return Effect.void;
    }),
  );

export const parseConfig = (path: string, contents: string) =>
  Effect.gen(function* () {
    yield* rejectLegacySshCidr(path, contents);
    return yield* decodeConfig(contents).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path,
            message: `Invalid ${path}: ${cause.message}`,
            cause,
          }),
      ),
    );
  });

export const loadConfig = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigError({
            path,
            message: `Cannot read required config ${path}: ${cause.message}`,
            cause,
          }),
      ),
    );
    return yield* parseConfig(path, contents);
  });
