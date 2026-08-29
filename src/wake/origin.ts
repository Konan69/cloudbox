const ORIGIN_WITHOUT_PATH = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/iu;

export const isWakeAllowedOrigin = (value: string): boolean => {
  if (!ORIGIN_WITHOUT_PATH.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname.length > 0 &&
      !url.hostname.includes("*") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
};

export const parseWakeAllowedOrigins = (value: string): ReadonlyArray<string> => {
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !isWakeAllowedOrigin(origin))) {
    throw new Error("WAKE_ALLOWED_ORIGINS must be a comma-separated list of origins without paths");
  }
  return origins;
};
