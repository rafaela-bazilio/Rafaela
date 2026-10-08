import { fileTypeFromBuffer } from "file-type";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const root = process.env.MEDIA_DIR ?? "/workspace/crm-media";
const allowed = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "video/webm",
  "audio/mp4",
  "audio/x-m4a",
  "video/mp4",
]);
export async function saveMedia(
  bytes: Uint8Array,
  name: string,
  claimedMime: string,
) {
  if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES)
    throw new Error("INVALID_MEDIA");
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !allowed.has(detected.mime))
    throw new Error("INVALID_MEDIA");
  // MP4/WebM containers are accepted as audio only when the declared type is audio.
  if (
    (detected.mime === "video/webm" || detected.mime === "video/mp4") &&
    !claimedMime.startsWith("audio/")
  )
    throw new Error("INVALID_MEDIA");
  const canonicalMime =
    detected.mime === "audio/x-m4a" ? "audio/mp4" : detected.mime;
  const mimeType = canonicalMime.startsWith("video/")
    ? canonicalMime.replace("video/", "audio/")
    : canonicalMime;
  if (
    claimedMime &&
    claimedMime.split(";")[0] !== mimeType &&
    !(mimeType === "audio/mp4" && claimedMime === "audio/x-m4a") &&
    !(mimeType === "audio/ogg" && claimedMime === "application/ogg") &&
    !(mimeType === "audio/x-wav" && claimedMime === "audio/wav")
  )
    throw new Error("INVALID_MEDIA");
  const filePath = randomUUID();
  const safeName =
    name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100) ||
    `arquivo.${detected.ext}`;
  const fileName =
    safeName.replace(/\.[a-zA-Z0-9]{1,10}$/, "") + "." + detected.ext;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    /* turbopackIgnore: true */ join(
      /* turbopackIgnore: true */ root,
      filePath,
    ),
    bytes,
    { mode: 0o600, flag: "wx" },
  );
  return { filePath, fileName, mimeType, fileSize: bytes.byteLength };
}
export async function readMedia(filePath: string) {
  if (!/^[a-f0-9-]{36}$/.test(filePath)) throw new Error("INVALID_MEDIA");
  return readFile(
    /* turbopackIgnore: true */ join(
      /* turbopackIgnore: true */ root,
      filePath,
    ),
  );
}
export async function removeMedia(filePath: string) {
  if (/^[a-f0-9-]{36}$/.test(filePath))
    await unlink(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ root,
        filePath,
      ),
    ).catch(() => {});
}
export function evolutionEndpoint(path: string) {
  const base = process.env.EVOLUTION_URL;
  if (
    !base ||
    !process.env.EVOLUTION_API_KEY ||
    !process.env.EVOLUTION_INSTANCE
  )
    throw new Error("PROVIDER_NOT_CONFIGURED");
  const url = new URL(path, base);
  if (url.protocol !== "https:") throw new Error("PROVIDER_REQUIRES_HTTPS");
  return url;
}
export async function fetchIncomingMedia(
  key: { id: string; remoteJid: string; fromMe: boolean },
  name: string,
  mime: string,
) {
  const url = evolutionEndpoint(
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(process.env.EVOLUTION_INSTANCE!)}`,
  );
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: {
      apikey: process.env.EVOLUTION_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { key }, convertToMp4: false }),
  });
  if (!response.ok) throw new Error("MEDIA_DOWNLOAD_FAILED");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_MEDIA_BYTES * 1.5) throw new Error("INVALID_MEDIA");
  // Limit streamed JSON too: Content-Length is not trusted.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MEDIA_DOWNLOAD_FAILED");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_MEDIA_BYTES * 1.5) {
        await reader.cancel();
        throw new Error("INVALID_MEDIA");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(parts).toString()) as {
    base64?: string;
  };
  if (!data.base64) throw new Error("MEDIA_DOWNLOAD_FAILED");
  return saveMedia(
    Buffer.from(data.base64.replace(/^data:[^;]+;base64,/, ""), "base64"),
    name,
    mime,
  );
}
