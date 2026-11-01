export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function toBufferSource(bytes: Uint8Array): BufferSource {
  return copyToArrayBuffer(bytes);
}

export function toBlobPart(bytes: Uint8Array): BlobPart {
  return copyToArrayBuffer(bytes);
}

export type DownloadProgress = {
  loaded: number;
  total: number | null;
  fraction: number | null;
};

export type DownloadProgressHandler = (progress: DownloadProgress) => void;

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Reads a response body without discarding byte progress when Content-Length is available. */
export async function readResponseBytesWithProgress(
  response: Response,
  onProgress?: DownloadProgressHandler,
): Promise<Uint8Array> {
  const total = contentLength(response);
  onProgress?.({ loaded: 0, total, fraction: total == null ? null : 0 });
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({
      loaded: bytes.byteLength,
      total: total ?? bytes.byteLength,
      fraction: 1,
    });
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({
      loaded,
      total,
      fraction: total == null ? null : Math.min(1, loaded / total),
    });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.({
    loaded,
    total: total ?? loaded,
    fraction: 1,
  });
  return bytes;
}
