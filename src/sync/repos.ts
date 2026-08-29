import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { RepoConfig } from "../config.ts";

export type RepoInspection =
  | { readonly status: "missing" }
  | { readonly status: "not-git" }
  | {
      readonly status: "git";
      readonly origin: string;
      readonly remoteRefsFingerprint: string;
    };

export type RepoSyncDecision =
  | { readonly action: "clone" }
  | { readonly action: "fetch"; readonly remoteRefsFingerprint: string }
  | { readonly action: "conflict"; readonly message: string };

export class RepoParityError extends Data.TaggedError("RepoParityError")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const repoPathPreamble = (repo: RepoConfig): string => String.raw`
readonly DISPLAY_PATH=${shellQuote(repo.path)}
readonly RELATIVE_PATH=${shellQuote(repo.path.slice(2))}
readonly REPO_PATH="$HOME/$RELATIVE_PATH"
readonly HOME_REAL="$(realpath -e -- "$HOME")"
readonly REPO_REAL="$(realpath -m -- "$REPO_PATH")"
case "$REPO_REAL" in
  "$HOME_REAL"/*) ;;
  *)
    printf 'Repository path escapes the box user home: %s\n' "$DISPLAY_PATH" >&2
    exit 1
    ;;
esac
`;

export const buildRepoInspectScript = (repo: RepoConfig): string => String.raw`#!/usr/bin/env bash
set -euo pipefail
${repoPathPreamble(repo)}
if [[ ! -e "$REPO_PATH" && ! -L "$REPO_PATH" ]]; then
  printf 'missing\n'
  exit 0
fi
if [[ ! -d "$REPO_PATH" ]]; then
  printf 'not-git\n'
  exit 0
fi
top_level="$(git -C "$REPO_PATH" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$top_level" ]] || [[ "$(realpath -e -- "$top_level")" != "$(realpath -e -- "$REPO_PATH")" ]]; then
  printf 'not-git\n'
  exit 0
fi
origin="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || true)"
encoded_origin="$(printf '%s' "$origin" | base64 --wrap=0)"
fingerprint="$(git -C "$REPO_PATH" for-each-ref --format='%(refname) %(objectname)' refs/remotes/origin | sha256sum | cut -d ' ' -f 1)"
printf 'git\t%s\t%s\n' "$encoded_origin" "$fingerprint"
`;

export const parseRepoInspection = (output: string): RepoInspection => {
  const line = output.trimEnd();
  if (line === "missing") return { status: "missing" };
  if (line === "not-git") return { status: "not-git" };
  const [status, encodedOrigin, remoteRefsFingerprint, ...extra] = line.split("\t");
  if (
    status !== "git" ||
    encodedOrigin === undefined ||
    remoteRefsFingerprint === undefined ||
    remoteRefsFingerprint.length === 0 ||
    extra.length > 0
  ) {
    throw new Error(`Invalid repository inspection output: ${JSON.stringify(output)}`);
  }
  return {
    status: "git",
    origin: Buffer.from(encodedOrigin, "base64").toString("utf8"),
    remoteRefsFingerprint,
  };
};

const gitCredentialEnvironment = (repo: RepoConfig): string =>
  repo.url.startsWith("https://")
    ? "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='!gh auth git-credential' "
    : "";

export const buildRepoCloneScript = (repo: RepoConfig): string => {
  const branch = repo.branch === undefined ? "" : `--branch ${shellQuote(repo.branch)} `;
  return String.raw`#!/usr/bin/env bash
set -euo pipefail
${repoPathPreamble(repo)}
if [[ -e "$REPO_PATH" || -L "$REPO_PATH" ]]; then
  printf 'Refusing to clone over an existing path: %s\n' "$DISPLAY_PATH" >&2
  exit 1
fi
mkdir -p -- "$(dirname "$REPO_PATH")"
GIT_TERMINAL_PROMPT=0 ${gitCredentialEnvironment(repo)}git clone ${branch}-- ${shellQuote(repo.url)} "$REPO_PATH"
`;
};

export const buildRepoFetchScript = (repo: RepoConfig): string => String.raw`#!/usr/bin/env bash
set -euo pipefail
${repoPathPreamble(repo)}
top_level="$(git -C "$REPO_PATH" rev-parse --show-toplevel 2>/dev/null || true)"
actual_origin="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || true)"
if [[ -z "$top_level" ]] || [[ "$(realpath -e -- "$top_level")" != "$(realpath -e -- "$REPO_PATH")" ]] || [[ "$actual_origin" != ${shellQuote(repo.url)} ]]; then
  printf 'Repository changed before fetch: %s (expected origin %s, found %s)\n' "$DISPLAY_PATH" ${shellQuote(repo.url)} "$actual_origin" >&2
  exit 1
fi
GIT_TERMINAL_PROMPT=0 ${gitCredentialEnvironment(repo)}git -C "$REPO_PATH" fetch --prune origin
`;

export const decideRepoSync = (
  repo: Pick<RepoConfig, "path" | "url">,
  inspection: RepoInspection,
): RepoSyncDecision => {
  if (inspection.status === "missing") return { action: "clone" };
  if (inspection.status === "not-git") {
    return {
      action: "conflict",
      message: `${repo.path} exists but is not a Git repository with origin ${repo.url}. Refusing to overwrite it.`,
    };
  }
  if (inspection.origin !== repo.url) {
    const found = inspection.origin.length === 0 ? "no origin" : `origin ${inspection.origin}`;
    return {
      action: "conflict",
      message: `${repo.path} has ${found}; expected origin ${repo.url}. Refusing to overwrite it.`,
    };
  }
  return { action: "fetch", remoteRefsFingerprint: inspection.remoteRefsFingerprint };
};

export interface RepoSyncOperator {
  readonly inspect: (repo: RepoConfig) => Effect.Effect<RepoInspection, RepoParityError>;
  readonly clone: (repo: RepoConfig) => Effect.Effect<void, RepoParityError>;
  readonly fetch: (repo: RepoConfig) => Effect.Effect<void, RepoParityError>;
}

const conflict = (repo: RepoConfig, message: string) =>
  Effect.fail(new RepoParityError({ path: repo.path, message }));

export const runRepoParity = (
  repos: ReadonlyArray<RepoConfig>,
  operator: RepoSyncOperator,
) =>
  Effect.forEach(
    repos,
    (repo) =>
      Effect.gen(function* () {
        const before = decideRepoSync(repo, yield* operator.inspect(repo));
        if (before.action === "conflict") return yield* conflict(repo, before.message);
        if (before.action === "clone") {
          yield* operator.clone(repo);
          yield* Console.log(`Repo cloned: ${repo.path}`);
          return;
        }

        yield* operator.fetch(repo);
        const after = decideRepoSync(repo, yield* operator.inspect(repo));
        if (after.action === "conflict") return yield* conflict(repo, after.message);
        if (after.action !== "fetch") {
          return yield* conflict(
            repo,
            `${repo.path} disappeared while fetching. Repository parity is incomplete.`,
          );
        }
        const status = after.remoteRefsFingerprint === before.remoteRefsFingerprint
          ? "unchanged"
          : "fetched";
        yield* Console.log(`Repo ${status}: ${repo.path}`);
      }),
    { discard: true },
  );
