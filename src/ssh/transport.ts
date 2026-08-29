import * as Data from "effect/Data";
import { accessSync, constants as FsConstants } from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { CloudboxConfig } from "../config.ts";

export class SshTransportError extends Data.TaggedError("SshTransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SshArgsOptions {
  readonly batchMode?: boolean;
  readonly connectTimeoutSeconds?: number;
  readonly serverAliveIntervalSeconds?: number;
  readonly serverAliveCountMax?: number;
  readonly strictHostKeyChecking?: boolean;
  readonly extra?: ReadonlyArray<string>;
}

export interface SshTransport {
  readonly provider: "aws" | "gcp";
  readonly host: string;
  readonly target: string;
  readonly privateKeyPath: string;
  readonly args: (options?: SshArgsOptions) => ReadonlyArray<string>;
  readonly rsyncRemoteShell: (options?: SshArgsOptions) => string;
}

export interface SshPrerequisiteOptions {
  readonly path?: string | undefined;
  readonly isExecutable?: ((path: string) => boolean) | undefined;
}

export const privateKeyPathFromConfig = (publicKeyPath: string): string => {
  const expanded = publicKeyPath === "~" || publicKeyPath.startsWith("~/")
    ? NodePath.join(NodeOs.homedir(), publicKeyPath.slice(2))
    : NodePath.resolve(publicKeyPath);
  if (!expanded.endsWith(".pub")) {
    throw new SshTransportError({
      message: `sshPublicKeyPath must end in .pub so SSH can select its private key: ${publicKeyPath}`,
    });
  }
  return expanded.slice(0, -4);
};

export const gcpInstanceName = (config: CloudboxConfig): string =>
  `cloudbox-${config.name}`;

const sshOption = (value: string): ReadonlyArray<string> => ["-o", value];

const buildOptions = (
  config: CloudboxConfig,
  privateKeyPath: string,
  options: SshArgsOptions,
): ReadonlyArray<string> => [
  "-i",
  privateKeyPath,
  ...(config.provider === "gcp"
    ? [
        ...sshOption(
          `ProxyCommand=gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project ${config.gcp.project} --zone ${config.gcp.zone} --verbosity=warning`,
        ),
        ...sshOption("UserKnownHostsFile=~/.ssh/cloudbox_known_hosts"),
        ...sshOption("StrictHostKeyChecking=accept-new"),
      ]
    : options.strictHostKeyChecking === true
      ? sshOption("StrictHostKeyChecking=accept-new")
      : []),
  ...(options.batchMode === true ? sshOption("BatchMode=yes") : []),
  ...(options.connectTimeoutSeconds === undefined
    ? []
    : sshOption(`ConnectTimeout=${String(options.connectTimeoutSeconds)}`)),
  ...(options.serverAliveIntervalSeconds === undefined
    ? []
    : sshOption(`ServerAliveInterval=${String(options.serverAliveIntervalSeconds)}`)),
  ...(options.serverAliveCountMax === undefined
    ? []
    : sshOption(`ServerAliveCountMax=${String(options.serverAliveCountMax)}`)),
];

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./~-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildSshTransport = (
  config: CloudboxConfig,
  awsHost?: string,
): SshTransport => {
  if (config.provider === "gcp" && awsHost !== undefined) {
    throw new SshTransportError({
      message: `--host is AWS-only; GCP SSH uses instance name ${gcpInstanceName(config)} through IAP`,
    });
  }
  if (config.provider === "aws" && (awsHost === undefined || awsHost.trim().length === 0)) {
    throw new SshTransportError({
      message: "AWS SSH requires a public IP or hostname via --host",
    });
  }

  const host = config.provider === "gcp" ? gcpInstanceName(config) : awsHost!.trim();
  const privateKeyPath = privateKeyPathFromConfig(config.sshPublicKeyPath);
  const target = `${config.boxUser}@${host}`;
  const optionsFor = (options: SshArgsOptions = {}) =>
    buildOptions(config, privateKeyPath, options);

  return {
    provider: config.provider,
    host,
    target,
    privateKeyPath,
    args: (options = {}) => [...optionsFor(options), ...(options.extra ?? []), target],
    rsyncRemoteShell: (options = {}) =>
      ["ssh", ...optionsFor(options), ...(options.extra ?? [])].map(shellQuote).join(" "),
  };
};

const defaultIsExecutable = (path: string): boolean => {
  try {
    accessSync(path, FsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const assertSshPrerequisites = (
  config: CloudboxConfig,
  options: SshPrerequisiteOptions = {},
): void => {
  if (config.provider !== "gcp") return;
  const path = options.path ?? process.env.PATH ?? "";
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const found = path
    .split(NodePath.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => isExecutable(NodePath.join(entry, "gcloud")));
  if (!found) {
    throw new SshTransportError({
      message: "gcloud is required for GCP SSH through IAP but was not found on PATH. Install the Google Cloud CLI and authenticate it before running cloudbox.",
    });
  }
};

export const requireSshTransport = (
  config: CloudboxConfig,
  awsHost?: string,
): SshTransport => {
  const transport = buildSshTransport(config, awsHost);
  assertSshPrerequisites(config);
  return transport;
};
