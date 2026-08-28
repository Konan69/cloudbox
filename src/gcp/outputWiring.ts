import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";

/** Compose an IAM member without coercing an unresolved resource attribute. */
export const iamServiceAccountMember = (
  email: Output.Output<string>,
): Input<string> => Output.interpolate`serviceAccount:${email}`;

/** Select the Compute Engine default identity used by Cloud Build in new projects. */
export const cloudBuildServiceAccountEmail = (
  projectNumber: Output.Output<string>,
): Output.Output<string> =>
  Output.interpolate`${projectNumber}-compute@developer.gserviceaccount.com`;
