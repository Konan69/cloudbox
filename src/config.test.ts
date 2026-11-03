import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConfigError, parseConfig } from "./config.ts";

const valid = {
  provider: "aws" as const,
  name: "dev",
  region: "us-east-1",
  instanceType: "m7i.4xlarge",
  diskGb: 300,
  aws: { sshCidr: "203.0.113.10/32" },
  sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
  idleMinutes: 30,
  t3: {
    repoUrl: "https://github.com/pingdotgg/t3code.git",
    branch: "main",
    settingsParity: { enabled: true, keybindings: true },
  },
  identity: {
    paths: ["~/.pi/agent/settings.json"],
    excludes: ["sessions/"],
    maxTransferMb: 300,
  },
  bootstrap: {
    paths: ["~/.t3/userdata/", "~/src/"],
    excludes: ["*.sqlite-shm", "*.sqlite-wal", "node_modules/"],
    maxTransferMb: 2_000,
  },
  repos: [
    { url: "https://github.com/example/one.git", path: "~/src/one", branch: "main" },
    { url: "git@github.com:example/two.git", path: "~/src/two" },
  ],
  boxUser: "dev",
};

const validGcp = {
  provider: "gcp" as const,
  name: valid.name,
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
  sshPublicKeyPath: valid.sshPublicKeyPath,
  idleMinutes: valid.idleMinutes,
  t3: valid.t3,
  identity: valid.identity,
  repos: valid.repos,
  boxUser: valid.boxUser,
};

const validBoat = {
  provider: "boat" as const,
  name: valid.name,
  boat: {
    type: "xlarge" as const,
    ttlSeconds: null,
    environment: "base",
  },
  sshPublicKeyPath: valid.sshPublicKeyPath,
  idleMinutes: valid.idleMinutes,
  t3: { settingsParity: valid.t3.settingsParity },
  identity: valid.identity,
  bootstrap: valid.bootstrap,
  repos: valid.repos,
  boxUser: "user" as const,
};

describe("CloudboxConfig", () => {
  it("accepts a configured Linux account and optional relay settings", async () => {
    const t3 = {
      ...valid.t3,
      relayUrl: "https://relay.example.com",
      clerkPublishableKey: "example-publishable-key",
      clerkCliOauthClientId: "example-client-id",
    };
    const config = await Effect.runPromise(parseConfig(
      "cloudbox.json",
      JSON.stringify({ ...valid, boxUser: "coder", t3 }),
    ));
    expect(config.boxUser).toBe("coder");
    expect(config.t3).toEqual(t3);
  });

  it.effect("decodes a complete config", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig("cloudbox.json", JSON.stringify(valid));
      expect(config.provider).toBe("aws");
      if (config.provider === "aws") expect(config.instanceType).toBe("m7i.4xlarge");
      expect(config.boxUser).toBe("dev");
      expect(config.repos).toHaveLength(2);
      expect(config.t3.settingsParity).toEqual({ enabled: true, keybindings: true });
      expect(config.bootstrap?.paths).toEqual(["~/.t3/userdata/", "~/src/"]);
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

  it.effect("decodes GCP without any SSH CIDR", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig("cloudbox.json", JSON.stringify(validGcp));
      expect(config.provider).toBe("gcp");
      if (config.provider === "gcp") expect(config.gcp.zone).toBe("us-central1-a");
      expect("sshCidr" in config).toBe(false);
    }),
  );

  it.effect("hard-fails when required GCP values are missing", () =>
    Effect.gen(function* () {
      const { credentials: _credentials, ...gcpWithoutCredentials } = validGcp.gcp;
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...validGcp, gcp: gcpWithoutCredentials }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("credentials");
    }),
  );

  it.effect("decodes the Boat provider with explicit size, TTL, and environment", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig("cloudbox.json", JSON.stringify(validBoat));
      expect(config.provider).toBe("boat");
      if (config.provider === "boat") {
        expect(config.boat).toEqual({ type: "xlarge", ttlSeconds: null, environment: "base" });
        expect(config.t3).toEqual({ settingsParity: { enabled: true, keybindings: true } });
        expect(config.boxUser).toBe("user");
      }
    }),
  );

  it.effect("rejects T3 build inputs from the stock Boat sandbox config", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({
          ...validBoat,
          t3: {
            ...validBoat.t3,
            repoUrl: "https://github.com/pingdotgg/t3code.git",
            branch: "main",
          },
        }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("repoUrl");
    }),
  );

  it.effect("accepts a positive Boat TTL and rejects zero", () =>
    Effect.gen(function* () {
      const finite = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...validBoat, boat: { type: "default", ttlSeconds: 7200 } }),
      );
      expect(finite.provider).toBe("boat");

      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...validBoat, boat: { type: "small", ttlSeconds: 0 } }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("ttlSeconds");
    }),
  );

  it.effect("keeps Boat-only fields out of AWS and GCP configs", () =>
    Effect.gen(function* () {
      for (const config of [
        { ...valid, boat: validBoat.boat },
        { ...validGcp, boat: validBoat.boat },
      ]) {
        const error = yield* parseConfig("cloudbox.json", JSON.stringify(config)).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toContain("boat");
      }
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

  it.effect("refuses bootstrap paths outside the user home", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({
          ...valid,
          bootstrap: { ...valid.bootstrap, paths: ["/tank/threads/"] },
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("bootstrap");
    }),
  );

  it.effect("validates repository URLs, home-relative paths, and unique destinations", () =>
    Effect.gen(function* () {
      for (const repos of [
        [{ url: "http://github.com/example/repo.git", path: "~/src/repo" }],
        [{ url: "file:///tmp/repo", path: "~/src/repo" }],
        [{ url: "https://github.com/example/repo.git", path: "/srv/repo" }],
        [{ url: "https://github.com/example/repo.git", path: "~/../repo" }],
        [{ url: "https://github.com/example/repo.git", path: "~/src/repo", branch: "bad..branch" }],
        [
          { url: "https://github.com/example/one.git", path: "~/src/repo" },
          { url: "ssh://git@github.com/example/two.git", path: "~/src/repo" },
        ],
      ]) {
        const error = yield* parseConfig(
          "cloudbox.json",
          JSON.stringify({ ...valid, repos }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ConfigError);
        expect(error.message).toContain("repos");
      }
    }),
  );

  it.effect("requires explicit T3 settings parity controls", () =>
    Effect.gen(function* () {
      const { settingsParity: _removed, ...t3 } = valid.t3;
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...valid, t3 }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("settingsParity");
    }),
  );

  it.effect("refuses an internet-wide AWS SSH CIDR", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...valid, aws: { sshCidr: "0.0.0.0/0" } }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("sshCidr");
    }),
  );

  it.effect("rejects the legacy top-level SSH CIDR with migration guidance", () =>
    Effect.gen(function* () {
      const error = yield* parseConfig(
        "cloudbox.json",
        JSON.stringify({ ...valid, sshCidr: "203.0.113.10/32" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toContain("top-level sshCidr was removed");
      expect(error.message).toContain("aws.sshCidr");
      expect(error.message).toContain("GCP configs do not accept an SSH CIDR");
    }),
  );
});
