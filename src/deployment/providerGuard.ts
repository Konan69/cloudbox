import { readFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { CloudboxConfig } from "../config.ts";

type Provider = CloudboxConfig["provider"];

export const providerFromResourceType = (resourceType: string): Provider | undefined => {
  if (resourceType.startsWith("GCP.")) return "gcp";
  if (resourceType.startsWith("AWS.")) return "aws";
  return undefined;
};

export const assertProviderMatchesState = (
  requestedProvider: Provider,
  resourceType: string | undefined,
  stage: string,
): void => {
  if (resourceType === undefined) return;
  const deployedProvider = providerFromResourceType(resourceType);
  if (deployedProvider === undefined) {
    throw new Error(
      `Cannot determine the deployed provider for Cloudbox stage ${stage} from resource type ${resourceType}. Refusing to continue.`,
    );
  }
  if (deployedProvider !== requestedProvider) {
    throw new Error(
      `Cloudbox stage ${stage} is already deployed on ${deployedProvider}; changing provider to ${requestedProvider} is not a migration. Restore provider=${deployedProvider}, or use a separately designed and verified migration workflow.`,
    );
  }
};

const stagePattern = /^[a-z0-9]+(?:[-_a-z0-9]+)*$/iu;

export const currentAlchemyStage = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const stage = environment.ALCHEMY_STAGE ?? `dev_${environment.USER ?? "unknown"}`;
  if (!stagePattern.test(stage)) {
    throw new Error(`Invalid Alchemy stage ${JSON.stringify(stage)}`);
  }
  return stage;
};

export const guardProviderChange = async (
  requestedProvider: Provider,
  options: { readonly cwd?: string; readonly stage?: string } = {},
): Promise<void> => {
  const stage = options.stage ?? currentAlchemyStage();
  const statePath = NodePath.join(
    options.cwd ?? process.cwd(),
    ".alchemy",
    "state",
    "Cloudbox",
    stage,
    "CloudboxInstance.json",
  );
  let contents: string;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  const parsed = JSON.parse(contents) as { readonly resourceType?: unknown };
  if (typeof parsed.resourceType !== "string") {
    throw new Error(
      `Cannot determine the deployed provider for Cloudbox stage ${stage}: ${statePath} has no resourceType. Refusing to continue.`,
    );
  }
  assertProviderMatchesState(requestedProvider, parsed.resourceType, stage);
};
