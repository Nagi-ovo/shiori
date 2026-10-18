// SHA-256 of raw bytes. Used as the primary key for draft lookup so the
// same PDF always maps to the same draft row regardless of filename changes.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto snapshots a BufferSource itself before returning its promise.
  // Pass ordinary views directly (including their offset/length), avoiding an
  // extra whole-PDF allocation on the UI thread. Shared buffers still need a
  // private copy because digest does not accept SharedArrayBuffer views.
  const input = bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
  const buf = await crypto.subtle.digest("SHA-256", input);
  const arr = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
