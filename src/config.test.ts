import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConfigError, parseConfig } from "./config.ts";

const valid = {
  provider: "aws" as const,
  name: "dev",
  region: "us-east-1",
  instanceType: "m7i.4xlarge",
  diskGb: 300,
  sshCidr: "203.0.113.10/32",
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: {
    repoUrl: "https://github.com/example/t3code.git",
    branch: "main",
  },
  identity: {
    paths: ["~/.pi/agent/settings.json"],
    excludes: ["sessions/"],
    maxTransferMb: 300,
  },
  boxUser: "dev",
};

const validGcp = {
  ...valid,
  provider: "gcp" as const,
  region: undefined,
  instanceType: undefined,
  diskGb: undefined,
  gcp: {
    project: "cloudbox-project",
    zone: "us-central1-a",
    machineType: "n2-standard-16",
    bootDiskGb: 50,
    dataDiskGb: 300,
    dataDiskType: "pd-ssd",
    credentials: "adc",
  },
  wake: { allowedOrigins: ["https://app.example.test", "http://localhost:3000"] },
};

describe("CloudboxConfig", () => {
  it.effect("decodes a complete config", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig("cloudbox.json", JSON.stringify(valid));
      expect(config.provider).toBe("aws");
      if (config.provider === "aws") expect(config.instanceType).toBe("m7i.4xlarge");
      expect(config.boxUser).toBe("dev");
    }),
  );

  it.effect("hard-fails when instanceType is missing", () =>
    Effect.gen(function* () {
      const { instanceType: _removed, ...missing } = valid;
      const error = yield* parseConfig("cloudbox.json", JSON.stringify(missing)).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("instanceType");
    }),
  );

  it.effect("hard-fails when required GCP values are missing", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({
          ...valid,
          provider: "gcp",
          region: undefined,
          instanceType: undefined,
          diskGb: undefined,
          gcp: {
            project: "cloudbox-project",
            zone: "us-central1-a",
            machineType: "n2-standard-16",
            bootDiskGb: 50,
            dataDiskGb: 300,
            dataDiskType: "pd-ssd",
          },
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("credentials");
    }),
  );

  it.effect("requires a non-empty wake allowedOrigins list for GCP", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig("cloudbox.json", JSON.stringify(validGcp));
      expect(config.provider).toBe("gcp");
      if (config.provider === "gcp") {
        expect(config.wake.allowedOrigins).toEqual([
          "https://app.example.test",
          "http://localhost:3000",
        ]);
      }

      const emptyError = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...validGcp, wake: { allowedOrigins: [] } }),
      ).pipe(Effect.flip);
      expect(emptyError).toBeInstanceOf(ConfigError);
      expect(emptyError.message).toContain("allowedOrigins");

      const { wake: _wake, ...missingWake } = validGcp;
      const missingError = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify(missingWake),
      ).pipe(Effect.flip);
      expect(missingError).toBeInstanceOf(ConfigError);
      expect(missingError.message).toContain("wake");
    }),
  );

  it.effect("rejects wake origins with paths or wildcards", () =>
    Effect.gen(function* () {
      for (const origin of [
        "https://app.example.test/not-an-origin",
        "https://*.example.test",
      ]) {
        const error = yield* parseConfig(
          "cloudbox.json",
          JSON.stringify({
            ...validGcp,
            wake: { allowedOrigins: [origin] },
          }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toContain('["wake"]["allowedOrigins"][0]');
      }
    }),
  );

  it.effect("refuses identity paths outside the user home", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({
          ...valid,
          identity: { ...valid.identity, paths: ["/home/dev/.pi/agent/settings.json"] },
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("identity");
    }),
  );

  it.effect("refuses an internet-wide SSH CIDR", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...valid, sshCidr: "0.0.0.0/0" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("sshCidr");
    }),
  );
});
