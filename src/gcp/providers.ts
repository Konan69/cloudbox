import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";

import type { GcpCredentials } from "../config.ts";
import { GcpApi } from "./client.ts";
import {
  GcpDisk,
  GcpDiskProvider,
  GcpFirewallRule,
  GcpFirewallRuleProvider,
  GcpInstance,
  GcpInstanceProvider,
} from "./resources.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("GCP") {}

export interface GcpProviderOptions {
  readonly project: string;
  readonly credentials: GcpCredentials;
}

export const providers = (options: GcpProviderOptions) => {
  const api = new GcpApi(options);
  return Layer.effect(
    Providers,
    Provider.collection([GcpFirewallRule, GcpDisk, GcpInstance]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        GcpFirewallRuleProvider(api),
        GcpDiskProvider(api),
        GcpInstanceProvider(api),
      ),
    ),
  );
};
