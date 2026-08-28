import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const TAR_BLOCK_SIZE = 512;

const writeString = (buffer: Buffer, offset: number, length: number, value: string) => {
  buffer.write(value.slice(0, length), offset, length, "utf8");
};

const writeOctal = (buffer: Buffer, offset: number, length: number, value: number) => {
  const encoded = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeString(buffer, offset, length, `${encoded}\0`);
};

const tarEntry = (name: string, contents: Buffer): Buffer => {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((TAR_BLOCK_SIZE - (contents.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
  return Buffer.concat([header, contents, padding]);
};

export interface WakeSourceArchive {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export const makeWakeSourceArchive = (bundle: string): WakeSourceArchive => {
  const dockerfile = [
    "FROM node:24-slim",
    "WORKDIR /app",
    "COPY wake-service.mjs ./wake-service.mjs",
    "ENV NODE_ENV=production",
    "CMD [\"node\", \"wake-service.mjs\"]",
    "",
  ].join("\n");
  const tar = Buffer.concat([
    tarEntry("Dockerfile", Buffer.from(dockerfile, "utf8")),
    tarEntry("wake-service.mjs", Buffer.from(bundle, "utf8")),
    Buffer.alloc(TAR_BLOCK_SIZE * 2),
  ]);
  const bytes = gzipSync(tar, { level: 9 });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};
