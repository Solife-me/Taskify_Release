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
