const TOP_LEVEL_SCALAR_FIELDS = [
  "enableLegacyTokenStreaming",
  "enableProviderUpdateChecks",
  "enableAgentBrowserAccess",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
] as const;

const PROVIDER_CONFIG_FIELDS = {
  codex: ["enabled", "customModels"],
  claudeAgent: ["enabled", "customModels", "autoCompactWindow"],
  cursor: ["enabled", "apiEndpoint", "customModels"],
  grok: ["enabled", "customModels"],
  opencode: ["enabled", "serverUrl", "customModels"],
  pi: ["enabled", "defaultModel", "excludedProviders", "customModels"],
} as const;

export const T3_SETTINGS_ALLOW_LIST = {
  topLevel: [
    ...TOP_LEVEL_SCALAR_FIELDS,
    "backgroundActivity",
    "textGenerationModelSelection",
    "sourceControlWritingStyle",
    "sourceControlWriterModelSelection",
    "providers",
    "providerInstances",
    "observability",
  ],
  backgroundActivity: ["schemaVersion", "profile", "baseProfile", "overrides"],
  backgroundActivityOverrides: [
    "automaticGitFetchInterval",
    "providerHealthRefreshInterval",
    "hostPowerMonitorActiveInterval",
    "hostPowerMonitorIdleInterval",
    "idleClientTtl",
    "pauseWhenHostLocked",
    "pauseWhenHostLowPower",
    "pauseWhenClientLowPower",
    "pauseWhenOnBattery",
  ],
  modelSelection: ["instanceId", "model", "options"],
  sourceControlWritingStyle: ["mode", "customInstructions", "followChangeRequestTemplates"],
  observability: ["otlpTracesUrl", "otlpMetricsUrl"],
  providers: PROVIDER_CONFIG_FIELDS,
  providerInstance: ["driver", "displayName", "accentColor", "enabled", "config"],
} as const;

export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (record: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const pick = (record: JsonObject, fields: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(
    fields.flatMap((field) => hasOwn(record, field) ? [[field, record[field]]] : []),
  );

const filterModelSelection = (value: unknown): JsonObject | undefined =>
  isObject(value) ? pick(value, T3_SETTINGS_ALLOW_LIST.modelSelection) : undefined;

const filterBackgroundActivity = (value: unknown): JsonObject | undefined => {
  if (!isObject(value)) return undefined;
  const filtered = pick(value, ["schemaVersion", "profile", "baseProfile"]);
  if (isObject(value.overrides)) {
    filtered.overrides = pick(
      value.overrides,
      T3_SETTINGS_ALLOW_LIST.backgroundActivityOverrides,
    );
  }
  return filtered;
};

const isHomeRelativePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("~/") && !value.split("/").includes("..");

const providerConfigFields = (driver: string): ReadonlyArray<string> | undefined => {
  switch (driver) {
    case "codex": return PROVIDER_CONFIG_FIELDS.codex;
    case "claudeAgent": return PROVIDER_CONFIG_FIELDS.claudeAgent;
    case "cursor": return PROVIDER_CONFIG_FIELDS.cursor;
    case "grok": return PROVIDER_CONFIG_FIELDS.grok;
    case "opencode": return PROVIDER_CONFIG_FIELDS.opencode;
    case "pi": return PROVIDER_CONFIG_FIELDS.pi;
    default: return undefined;
  }
};

const filterProviderConfig = (
  driver: string,
  value: unknown,
): JsonObject | undefined => {
  const fields = providerConfigFields(driver);
  if (fields === undefined || !isObject(value)) return undefined;
  const filtered = pick(value, fields);
  // A home-relative shadow home names the same account on every machine; absolute paths stay local.
  if (driver === "codex" && isHomeRelativePath(value.shadowHomePath)) {
    filtered.shadowHomePath = value.shadowHomePath;
  }
  return filtered;
};

const filterProviders = (value: unknown): JsonObject | undefined => {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(
    Object.keys(PROVIDER_CONFIG_FIELDS).flatMap((driver) => {
      const filtered = filterProviderConfig(driver, value[driver]);
      return filtered === undefined ? [] : [[driver, filtered]];
    }),
  );
};

const filterProviderInstances = (value: unknown): JsonObject | undefined => {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([instanceId, unfiltered]) => {
      if (!isObject(unfiltered) || typeof unfiltered.driver !== "string") return [];
      const filtered = pick(unfiltered, ["driver", "displayName", "accentColor", "enabled"]);
      const config = filterProviderConfig(unfiltered.driver, unfiltered.config);
      if (config !== undefined) filtered.config = config;
      return [[instanceId, filtered]];
    }),
  );
};

export const filterPortableT3Settings = (value: unknown): JsonObject => {
  if (!isObject(value)) return {};
  const filtered = pick(value, TOP_LEVEL_SCALAR_FIELDS);

  const backgroundActivity = filterBackgroundActivity(value.backgroundActivity);
  if (backgroundActivity !== undefined) filtered.backgroundActivity = backgroundActivity;

  const textGenerationModelSelection = filterModelSelection(value.textGenerationModelSelection);
  if (textGenerationModelSelection !== undefined) {
    filtered.textGenerationModelSelection = textGenerationModelSelection;
  }

  if (isObject(value.sourceControlWritingStyle)) {
    filtered.sourceControlWritingStyle = pick(
      value.sourceControlWritingStyle,
      T3_SETTINGS_ALLOW_LIST.sourceControlWritingStyle,
    );
  }

  if (value.sourceControlWriterModelSelection === null) {
    filtered.sourceControlWriterModelSelection = null;
  } else {
    const sourceControlWriterModelSelection = filterModelSelection(
      value.sourceControlWriterModelSelection,
    );
    if (sourceControlWriterModelSelection !== undefined) {
      filtered.sourceControlWriterModelSelection = sourceControlWriterModelSelection;
    }
  }

  const providers = filterProviders(value.providers);
  if (providers !== undefined) filtered.providers = providers;

  const providerInstances = filterProviderInstances(value.providerInstances);
  if (providerInstances !== undefined) filtered.providerInstances = providerInstances;

  if (isObject(value.observability)) {
    filtered.observability = pick(value.observability, T3_SETTINGS_ALLOW_LIST.observability);
  }

  return filtered;
};

export interface T3ParityPublishPayload {
  readonly settingsJson?: string;
  readonly keybindings?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const buildT3ParityPublishScript = ({
  settingsJson,
  keybindings,
}: T3ParityPublishPayload): string => {
  const settingsBase64 = settingsJson === undefined
    ? ""
    : Buffer.from(settingsJson, "utf8").toString("base64");
  const keybindingsBase64 = keybindings === undefined
    ? ""
    : Buffer.from(keybindings, "utf8").toString("base64");

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
readonly SETTINGS_PATH="$HOME/.t3/userdata/settings.json"
readonly KEYBINDINGS_PATH="$HOME/.t3/userdata/keybindings.json"
readonly HAS_SETTINGS=${settingsJson === undefined ? "0" : "1"}
readonly HAS_KEYBINDINGS=${keybindings === undefined ? "0" : "1"}
readonly SETTINGS_BASE64=${shellQuote(settingsBase64)}
readonly KEYBINDINGS_BASE64=${shellQuote(keybindingsBase64)}

install -d -m 700 "$HOME/.t3/userdata"
settings_incoming=''
settings_merged=''
keybindings_incoming=''
cleanup() {
  if [[ -n "$settings_incoming" ]]; then rm -f -- "$settings_incoming"; fi
  if [[ -n "$settings_merged" ]]; then rm -f -- "$settings_merged"; fi
  if [[ -n "$keybindings_incoming" ]]; then rm -f -- "$keybindings_incoming"; fi
}
trap cleanup EXIT

if [[ "$HAS_SETTINGS" == 1 ]]; then
  settings_incoming="$(mktemp "$HOME/.t3/userdata/.settings-incoming.XXXXXX")"
  settings_merged="$(mktemp "$HOME/.t3/userdata/.settings-merged.XXXXXX")"
  printf '%s' "$SETTINGS_BASE64" | base64 --decode > "$settings_incoming"
  node - "$SETTINGS_PATH" "$settings_incoming" "$settings_merged" <<'NODE'
const fs = require("node:fs");
const [settingsPath, incomingPath, mergedPath] = process.argv.slice(2);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readObject = (path, missingValue) => {
  if (!fs.existsSync(path)) return missingValue;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    console.error("Cannot parse T3 settings JSON at " + path + ": " + String(error));
    process.exit(1);
  }
  if (!isObject(parsed)) {
    console.error("T3 settings JSON must contain an object: " + path);
    process.exit(1);
  }
  return parsed;
};
const merge = (host, local) => {
  if (!isObject(host) || !isObject(local)) return local;
  const output = { ...host };
  for (const [key, value] of Object.entries(local)) {
    output[key] = merge(host[key], value);
  }
  return output;
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const changes = [];
const collectChanges = (before, after, path) => {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    if (keys.length === 0 && !equal(before, after)) changes.push(path.join("."));
    for (const key of keys) collectChanges(before[key], after[key], [...path, key]);
    return;
  }
  if (!equal(before, after)) changes.push(path.join("."));
};
const host = readObject(settingsPath, {});
const local = readObject(incomingPath, {});
const merged = merge(host, local);
collectChanges(host, merged, []);
fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2) + "\n");
console.log(changes.length === 0
  ? "T3 settings unchanged"
  : "T3 settings changed fields: " + changes.join(", "));
NODE
  chmod 600 "$settings_merged"
  mv -- "$settings_merged" "$SETTINGS_PATH"
  settings_merged=''
  rm -f -- "$settings_incoming"
  settings_incoming=''
fi

if [[ "$HAS_KEYBINDINGS" == 1 ]]; then
  keybindings_incoming="$(mktemp "$HOME/.t3/userdata/.keybindings-incoming.XXXXXX")"
  printf '%s' "$KEYBINDINGS_BASE64" | base64 --decode > "$keybindings_incoming"
  if [[ -f "$KEYBINDINGS_PATH" ]] && cmp -s -- "$keybindings_incoming" "$KEYBINDINGS_PATH"; then
    printf 'T3 keybindings unchanged\n'
    rm -f -- "$keybindings_incoming"
  else
    chmod 600 "$keybindings_incoming"
    mv -- "$keybindings_incoming" "$KEYBINDINGS_PATH"
    printf 'T3 keybindings changed\n'
  fi
  keybindings_incoming=''
fi

printf 'Restart T3 to load changed settings or keybindings; Cloudbox did not restart it.\n'
`;
};
