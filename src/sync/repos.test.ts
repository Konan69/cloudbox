import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import type { RepoConfig } from "../config.ts";
import {
  buildRepoCloneScript,
  buildRepoFetchScript,
  buildRepoInspectScript,
  decideRepoSync,
  parseRepoInspection,
} from "./repos.ts";

const repo: RepoConfig = {
  url: "https://github.com/example/cloudbox.git",
  path: "~/src/cloudbox",
  branch: "main",
};

describe("repository parity decisions", () => {
  it("clones a missing repository", () => {
    expect(decideRepoSync(repo, { status: "missing" })).toEqual({ action: "clone" });
  });

  it("fetches a Git repository with the configured origin", () => {
    expect(
      decideRepoSync(repo, {
        status: "git",
        origin: repo.url,
        remoteRefsFingerprint: "before",
      }),
    ).toEqual({ action: "fetch", remoteRefsFingerprint: "before" });
  });

  it("fails rather than overwriting a repository with a different origin", () => {
    const decision = decideRepoSync(repo, {
      status: "git",
      origin: "git@github.com:someone-else/cloudbox.git",
      remoteRefsFingerprint: "before",
    });

    expect(decision.action).toBe("conflict");
    if (decision.action === "conflict") {
      expect(decision.message).toContain(repo.path);
      expect(decision.message).toContain("someone-else/cloudbox.git");
      expect(decision.message).toContain(`expected origin ${repo.url}`);
      expect(decision.message).toContain("Refusing to overwrite");
    }
  });

  it("fails rather than overwriting an existing non-repository path", () => {
    const decision = decideRepoSync(repo, { status: "not-git" });
    expect(decision.action).toBe("conflict");
    if (decision.action === "conflict") {
      expect(decision.message).toContain("is not a Git repository");
    }
  });
});

describe("repository parity remote scripts", () => {
  it("round-trips inspection output without exposing the origin parser to whitespace", () => {
    const origin = "git@github.com:example/cloudbox.git";
    const encoded = Buffer.from(origin, "utf8").toString("base64");
    expect(parseRepoInspection(`git\t${encoded}\trefs-hash\n`)).toEqual({
      status: "git",
      origin,
      remoteRefsFingerprint: "refs-hash",
    });
  });

  it("renders syntax-valid clone, inspect, and fetch scripts without pull or checkout", () => {
    const scripts = [
      buildRepoInspectScript(repo),
      buildRepoCloneScript(repo),
      buildRepoFetchScript(repo),
    ];
    for (const script of scripts) {
      const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(script).not.toMatch(/git\s+(?:pull|checkout|reset)\b/u);
    }
    expect(scripts[1]).toContain("git clone --branch 'main' --");
    expect(scripts[2]).toContain('git -C "$REPO_PATH" fetch --prune origin');
  });
});
