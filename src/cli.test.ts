import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildRsyncArgs,
  CloudboxCliError,
  runIdentitySync,
  type IdentitySyncInput,
  type RsyncRunner,
} from "./cli.ts";

const statsOutput = (files: number, bytes: number) => `
Number of regular files transferred: ${String(files)}
Total transferred file size: ${String(bytes)} bytes
`;

const syncInput: IdentitySyncInput = {
  paths: ["~/.claude/skills/", "~/.pi/agent/settings.json"],
  excludes: ["sessions/", "*.jsonl"],
  maxTransferMb: 1,
  localHome: "/home/laptop-user",
  boxUser: "dev",
  publicIp: "203.0.113.20",
  dryRun: false,
  force: false,
};

describe("cloudbox sync", () => {
  it("builds directory-content rsync arguments without assuming the remote absolute home", () => {
    const args = buildRsyncArgs({
      path: "~/.claude/skills/",
      localHome: "/home/laptop-user",
      boxUser: "dev",
      publicIp: "203.0.113.20",
      excludes: ["sessions/"],
      dryRun: true,
    });

    expect(args).toContain("--info=stats2,name1");
    expect(args).toContain("--dry-run");
    expect(args.at(-2)).toBe("/home/laptop-user/.claude/skills/");
    expect(args.at(-1)).toBe("dev@203.0.113.20:~/.claude/skills/");
    expect(args.at(-1)).not.toContain(":/home/laptop-user/");
  });

  it.effect("aborts after fake dry runs when the combined transfer exceeds the guard", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly path: string; readonly args: ReadonlyArray<string> }> = [];
      const runner: RsyncRunner = (path, args) =>
        Effect.sync(() => {
          calls.push({ path, args });
          return { stdout: statsOutput(2, 700_000), stderr: "" };
        });

      const error = yield* runIdentitySync(syncInput, runner).pipe(Effect.flip);

      expect(error).toBeInstanceOf(CloudboxCliError);
      expect(error.message).toContain("1400000 bytes");
      expect(error.message).toContain("~/.claude/skills/: 700000 bytes");
      expect(error.message).toContain("~/.pi/agent/settings.json: 700000 bytes");
      expect(error.message).toContain("identity.excludes");
      expect(error.message).toContain("--force");
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.args.includes("--dry-run"))).toBe(true);
    }),
  );

  it.effect("names the identity path when rsync fails", () =>
    Effect.gen(function* () {
      const runner: RsyncRunner = () =>
        Effect.fail(
          new CloudboxCliError({ operation: "rsync", message: "rsync exited with status 23" }),
        );

      const error = yield* runIdentitySync({ ...syncInput, dryRun: true }, runner).pipe(
        Effect.flip,
      );

      expect(error.message).toContain("rsync failed for ~/.claude/skills/");
    }),
  );

  it.effect("lets --force continue from fake dry runs to the real transfer", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const runner: RsyncRunner = (_path, args) =>
        Effect.sync(() => {
          calls.push(args);
          return { stdout: statsOutput(1, 700_000), stderr: "" };
        });

      yield* runIdentitySync({ ...syncInput, force: true }, runner);

      expect(calls).toHaveLength(4);
      expect(calls.slice(0, 2).every((args) => args.includes("--dry-run"))).toBe(true);
      expect(calls.slice(2).every((args) => !args.includes("--dry-run"))).toBe(true);
    }),
  );
});
