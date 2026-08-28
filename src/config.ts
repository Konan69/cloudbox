import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

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

export const T3Config = Schema.Struct({
  repoUrl: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
});

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
  wakeKeyRotation: PositiveInteger,
  credentials: GcpCredentials,
});

const SharedConfig = {
  name: Schema.NonEmptyString,
  sshCidr: SshCidr,
  sshPublicKeyPath: Schema.NonEmptyString,
  idleMinutes: PositiveInteger,
  t3: T3Config,
  identity: IdentityConfig,
  boxUser: Schema.Literal("dev"),
} as const;

export const AwsCloudboxConfig = Schema.Struct({
  ...SharedConfig,
  provider: Schema.Literal("aws"),
  region: Schema.NonEmptyString,
  instanceType: Schema.NonEmptyString,
  diskGb: PositiveInteger,
});

export const GcpCloudboxConfig = Schema.Struct({
  ...SharedConfig,
  name: GcpCloudboxName,
  provider: Schema.Literal("gcp"),
  gcp: GcpConfig,
});

export const CloudboxConfig = Schema.Union([AwsCloudboxConfig, GcpCloudboxConfig]);

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

export const parseConfig = (path: string, contents: string) =>
  decodeConfig(contents).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          path,
          message: `Invalid ${path}: ${cause.message}`,
          cause,
        }),
    ),
  );

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
