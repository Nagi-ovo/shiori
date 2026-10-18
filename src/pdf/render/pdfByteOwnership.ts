/**
 * Keep a full-span source view without cloning the whole PDF again. Callers
 * treat opened PDF bytes as immutable. Subarray inputs are normalized so a
 * small PDF view cannot retain an unrelated, much larger backing buffer.
 */
export function retainPdfSourceBytes(source: Uint8Array): Uint8Array {
  if (source.byteOffset === 0 && source.byteLength === source.buffer.byteLength) {
    return source;
  }
  return new Uint8Array(source);
}
