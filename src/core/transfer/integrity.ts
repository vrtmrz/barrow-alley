import { compatGlobal } from "../../compat-global.js";

/** Calculates lower-case SHA-256 hex over one complete byte array using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const digest = await compatGlobal.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Joins validated chunks into the complete byte array required by Web Crypto. */
export function concatenateChunks(
  chunks: readonly Uint8Array[],
  expectedLength: number,
): Uint8Array {
  const result = new Uint8Array(expectedLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== expectedLength) {
    throw new RangeError(`Expected ${String(expectedLength)} bytes, received ${String(offset)}.`);
  }
  return result;
}
