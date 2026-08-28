import { WakeGcpError, type WakeGcpClient, type WakeRateLimiter } from "./handler.ts";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const STORAGE_API = "https://storage.googleapis.com/storage/v1";
const STORAGE_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";

interface RuntimeConfig {
  readonly project: string;
  readonly zone: string;
  readonly instance: string;
}

const metadataTokenProvider = (fetchImpl: typeof fetch) => {
  let cached: { readonly value: string; readonly expiresAt: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt - 60_000 > now) return cached.value;
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new WakeGcpError({
        operation: "metadata token",
        status: response.status,
        message: "Cloud Run metadata server returned no access token",
      });
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3_600;
    cached = { value: body.access_token, expiresAt: now + expiresIn * 1_000 };
    return cached.value;
  };
};

export const makeCloudRunGcpClient = (
  config: RuntimeConfig,
  fetchImpl: typeof fetch = fetch,
): WakeGcpClient => {
  const token = metadataTokenProvider(fetchImpl);
  const request = async (operation: string, suffix = "", method = "GET") => {
    const url =
      `${COMPUTE_API}/projects/${encodeURIComponent(config.project)}` +
      `/zones/${encodeURIComponent(config.zone)}/instances/${encodeURIComponent(config.instance)}` +
      suffix;
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new WakeGcpError({
        operation,
        status: response.status,
        message: `${operation} returned HTTP ${String(response.status)}`,
      });
    }
    return response;
  };
  const changeState = async (operation: "resume" | "start") => {
    await request(
      `${operation} ${config.instance}`,
      `/${operation}?requestId=${encodeURIComponent(crypto.randomUUID())}`,
      "POST",
    );
  };
  return {
    getInstanceState: async () => {
      const response = await request(`get ${config.instance}`);
      const body = (await response.json()) as { readonly status?: unknown };
      if (typeof body.status !== "string") {
        throw new WakeGcpError({
          operation: `get ${config.instance}`,
          status: response.status,
          message: "Compute Engine response did not contain an instance status",
        });
      }
      return body.status;
    },
    resumeInstance: async () => changeState("resume"),
    startInstance: async () => changeState("start"),
  };
};

const objectMetadataUrl = (bucket: string, object: string) =>
  `${STORAGE_API}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
const objectMediaUrl = (bucket: string, object: string) =>
  `${objectMetadataUrl(bucket, object)}?alt=media`;
const objectUploadUrl = (bucket: string, object: string, generation: string) =>
  `${STORAGE_UPLOAD_API}/b/${encodeURIComponent(bucket)}/o?uploadType=media` +
  `&name=${encodeURIComponent(object)}&ifGenerationMatch=${encodeURIComponent(generation)}`;

export const makeGcsRateLimiter = (
  bucket: string,
  fetchImpl: typeof fetch = fetch,
): WakeRateLimiter => {
  const token = metadataTokenProvider(fetchImpl);
  const headers = async (contentType?: string) => ({
    Authorization: `Bearer ${await token()}`,
    ...(contentType === undefined ? {} : { "Content-Type": contentType }),
  });
  return {
    claim: async (name, nowEpochMs) => {
      const object = `wake-rate/${name}`;
      const metadataResponse = await fetchImpl(objectMetadataUrl(bucket, object), {
        headers: await headers(),
      });
      let generation = "0";
      if (metadataResponse.ok) {
        const metadata = (await metadataResponse.json()) as { generation?: unknown };
        if (typeof metadata.generation !== "string") {
          throw new WakeGcpError({ operation: "read wake rate metadata", status: metadataResponse.status, message: "GCS returned no object generation" });
        }
        generation = metadata.generation;
        const valueResponse = await fetchImpl(objectMediaUrl(bucket, object), {
          headers: await headers(),
        });
        if (!valueResponse.ok) {
          throw new WakeGcpError({ operation: "read wake rate value", status: valueResponse.status, message: "GCS rate object read failed" });
        }
        const previousEpochMs = Number(await valueResponse.text());
        if (Number.isFinite(previousEpochMs) && nowEpochMs - previousEpochMs < 60_000) {
          return false;
        }
      } else if (metadataResponse.status !== 404) {
        throw new WakeGcpError({ operation: "read wake rate metadata", status: metadataResponse.status, message: "GCS rate metadata read failed" });
      }

      const writeResponse = await fetchImpl(objectUploadUrl(bucket, object, generation), {
        method: "POST",
        headers: await headers("text/plain"),
        body: String(nowEpochMs),
      });
      if (writeResponse.status === 412) return false;
      if (!writeResponse.ok) {
        throw new WakeGcpError({ operation: "write wake rate value", status: writeResponse.status, message: "GCS rate object write failed" });
      }
      return true;
    },
  };
};
