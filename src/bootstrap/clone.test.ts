import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildSshTransport } from "../ssh/transport.ts";
import {
  BootstrapCloneError,
  buildBootstrapPullArgs,
  buildBootstrapPushArgs,
  runBootstrapClone,
  type BootstrapCloneInput,
  type BootstrapCloneRunner,
} from "./clone.ts";

const source = buildSshTransport(
  {
    provider: "aws",
    name: "source",
    region: "us-east-1",
    instanceType: "m7i.4xlarge",
    diskGb: 300,
    aws: { sshCidr: "203.0.113.10/32" },
    sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
    idleMinutes: 30,
    t3: {
      repoUrl: "https://example.test/t3.git",
      branch: "main",
      settingsParity: { enabled: true, keybindings: true },
    },
    identity: { paths: [], excludes: [], maxTransferMb: 100 },
    repos: [],
    boxUser: "dev",
  },
  "203.0.113.20",
);

const destination = buildSshTransport(
  {
    provider: "aws",
    name: "destination",
    region: "us-east-1",
    instanceType: "m7i.4xlarge",
    diskGb: 300,
    aws: { sshCidr: "203.0.113.10/32" },
    sshPublicKeyPath: "~/.ssh/id_ed25519.pub",
    idleMinutes: 30,
    t3: {
      repoUrl: "https://example.test/t3.git",
      branch: "main",
      settingsParity: { enabled: true, keybindings: true },
    },
    identity: { paths: [], excludes: [], maxTransferMb: 100 },
    repos: [],
    boxUser: "dev",
  },
  "203.0.113.30",
);

const input: BootstrapCloneInput = {
  paths: ["~/.t3/userdata/", "~/.config/gh/hosts.yml"],
  excludes: ["*.sqlite-wal", "node_modules/"],
  maxTransferMb: 10,
  cacheRoot: "/home/operator/.cache/cloudbox/bootstrap/source-to-destination",
  source,
  destination,
  dryRun: false,
  force: false,
};

const stats = (files: number, bytes: number) =>
  `Number of regular files transferred: ${String(files)}\nTotal transferred file size: ${String(bytes)} bytes\n`;

describe("box-to-box bootstrap clone", () => {
  it("builds resumable pull and push legs without deleting destination files", () => {
    const pull = buildBootstrapPullArgs(input, "~/.t3/userdata/", true);
    const push = buildBootstrapPushArgs(input, "~/.t3/userdata/", false);

    for (const args of [pull, push]) {
      expect(args).toContain("--partial");
      expect(args).toContain("--protect-args");
      expect(args).toContain("--partial-dir=.rsync-partial");
      expect(args).not.toContain("--delete");
      expect(args).toContain("--exclude=*.sqlite-wal");
    }
    expect(pull).toContain("--dry-run");
    expect(pull.at(-2)).toBe("dev@203.0.113.20:~/.t3/userdata/");
    expect(pull.at(-1)).toBe(
      "/home/operator/.cache/cloudbox/bootstrap/source-to-destination/.t3/userdata/",
    );
    expect(push).not.toContain("--dry-run");
    expect(push.at(-2)).toBe(
      "/home/operator/.cache/cloudbox/bootstrap/source-to-destination/.t3/userdata/",
    );
    expect(push.at(-1)).toBe("dev@203.0.113.30:~/.t3/userdata/");
  });

  it.effect("refreshes the cache before previewing and transferring the destination leg", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly leg: "pull" | "push"; readonly dryRun: boolean }> = [];
      const runner: BootstrapCloneRunner = (leg, _path, args) =>
        Effect.sync(() => {
          calls.push({ leg, dryRun: args.includes("--dry-run") });
          return { stdout: stats(1, 100), stderr: "" };
        });

      yield* runBootstrapClone(input, runner);

      expect(calls).toEqual([
        { leg: "pull", dryRun: true },
        { leg: "pull", dryRun: true },
        { leg: "pull", dryRun: false },
        { leg: "pull", dryRun: false },
        { leg: "push", dryRun: true },
        { leg: "push", dryRun: true },
        { leg: "push", dryRun: false },
        { leg: "push", dryRun: false },
      ]);
    }),
  );

  it.effect("dry-run reads only the source and leaves the cache and destination untouched", () =>
    Effect.gen(function* () {
      const calls: Array<"pull" | "push"> = [];
      const runner: BootstrapCloneRunner = (leg) => {
        calls.push(leg);
        return Effect.succeed({ stdout: stats(0, 0), stderr: "" });
      };

      yield* runBootstrapClone({ ...input, dryRun: true }, runner);

      expect(calls).toEqual(["pull", "pull"]);
    }),
  );

  it.effect("stops before cache mutation when the source delta exceeds the guard", () =>
    Effect.gen(function* () {
      const runner: BootstrapCloneRunner = () =>
        Effect.succeed({ stdout: stats(1, 6_000_000), stderr: "" });

      const error = yield* runBootstrapClone(input, runner).pipe(Effect.flip);

      expect(error).toBeInstanceOf(BootstrapCloneError);
      expect(error.message).toContain("12000000 bytes");
      expect(error.message).toContain("bootstrap.maxTransferMb=10");
      expect(error.message).toContain("--force");
    }),
  );

  it.effect("reports malformed rsync statistics as a typed clone failure", () =>
    Effect.gen(function* () {
      const runner: BootstrapCloneRunner = () =>
        Effect.succeed({ stdout: "rsync output without stats", stderr: "" });

      const error = yield* runBootstrapClone({ ...input, dryRun: true }, runner).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(BootstrapCloneError);
      expect(error.message).toContain("Invalid rsync statistics");
    }),
  );
});
