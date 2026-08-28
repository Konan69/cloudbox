import * as Schema from "effect/Schema";

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const AwsIdleProvider = Schema.Struct({
  kind: Schema.Literal("aws"),
  name: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
});

const GcpIdleProvider = Schema.Struct({
  kind: Schema.Literal("gcp"),
  name: Schema.NonEmptyString,
  project: Schema.NonEmptyString,
  zone: Schema.NonEmptyString,
});

const TcpT3Activity = Schema.Struct({ kind: Schema.Literal("tcp") });
const AuthenticatedT3Activity = Schema.Struct({
  kind: Schema.Literal("authenticated"),
  baseDir: Schema.NonEmptyString,
  tokenPath: Schema.NonEmptyString,
});

export const IdleConfig = Schema.Struct({
  provider: Schema.Union([AwsIdleProvider, GcpIdleProvider]),
  idleMinutes: PositiveInteger,
  t3Port: PositiveInteger,
  t3Activity: Schema.Union([TcpT3Activity, AuthenticatedT3Activity]),
  checkIncus: Schema.Boolean,
});

export type IdleConfig = typeof IdleConfig.Type;
export type AwsIdleProvider = typeof AwsIdleProvider.Type;
export type GcpIdleProvider = typeof GcpIdleProvider.Type;
export type AuthenticatedT3Activity = typeof AuthenticatedT3Activity.Type;

export const encodeIdleConfig = Schema.encodeSync(Schema.fromJsonString(IdleConfig));
