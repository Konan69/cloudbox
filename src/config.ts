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
  githubTokenEnv: Schema.NonEmptyString,
});

export const IdentityConfig = Schema.Struct({
  paths: Schema.Array(Schema.NonEmptyString),
  excludes: Schema.Array(Schema.NonEmptyString),
});

export const CloudboxConfig = Schema.Struct({
  name: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  instanceType: Schema.NonEmptyString,
  diskGb: PositiveInteger,
  sshCidr: SshCidr,
  sshPublicKeyPath: Schema.NonEmptyString,
  idleMinutes: PositiveInteger,
  t3: T3Config,
  identity: IdentityConfig,
  boxUser: Schema.Literal("dev"),
});

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
