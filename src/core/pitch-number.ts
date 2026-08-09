import { sha256Hex } from "./transfer/integrity.js";
import { compatGlobal } from "../compat-global.js";

const PITCH_NUMBER_LENGTH = 8;
const UNBIASED_DECIMAL_BYTE_LIMIT = 250;

/** Fills a caller-owned buffer with cryptographically secure random bytes. */
export type RandomByteFiller = (target: Uint8Array<ArrayBuffer>) => void;

/** Credentials derived from the user-entered Pitch number for one Trystero room. */
export interface PitchCredentials {
  readonly roomId: string;
  readonly password: string;
}

/** Indicates that a Pitch number is not exactly eight ASCII decimal digits. */
export class PitchNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PitchNumberError";
  }
}

const secureRandomBytes: RandomByteFiller = (target) => {
  compatGlobal.crypto.getRandomValues(target);
};

/**
 * Generates an eight-digit Pitch number without modulo bias.
 *
 * A Pitch number is deliberately convenient to communicate, and therefore has
 * limited entropy. It identifies a temporary pitch; it is not a replacement for
 * the explicit visitor approval shown by the sender.
 */
export function generatePitchNumber(fill: RandomByteFiller = secureRandomBytes): string {
  const digits: number[] = [];
  while (digits.length < PITCH_NUMBER_LENGTH) {
    const candidates = new Uint8Array(PITCH_NUMBER_LENGTH - digits.length);
    fill(candidates);
    for (const candidate of candidates) {
      if (candidate < UNBIASED_DECIMAL_BYTE_LIMIT) {
        digits.push(candidate % 10);
      }
    }
  }
  return digits.join("");
}

/** Returns the canonical eight-digit representation accepted by the protocol UI. */
export function validatePitchNumber(input: string): string {
  const trimmed = input.trim();
  const canonical = /^\d{8}$/u.test(trimmed)
    ? trimmed
    : /^(\d{4}) (\d{4})$/u.exec(trimmed)?.slice(1).join("");
  if (canonical === undefined || !/^[0-9]{8}$/u.test(canonical)) {
    throw new PitchNumberError("A Pitch number must contain exactly eight decimal digits.");
  }
  return canonical;
}

/** Formats a valid Pitch number for the compact 'Pitch No.' UI heading. */
export function formatPitchNumber(input: string): string {
  const canonical = validatePitchNumber(input);
  return `${canonical.slice(0, 4)} ${canonical.slice(4)}`;
}

/**
 * Derives separate opaque Trystero room and password inputs from a Pitch number.
 *
 * Domain separation prevents either derived value from being reused as the
 * other. The derivation obscures the displayed number in signalling metadata,
 * but cannot add entropy to its eight decimal digits.
 */
export async function derivePitchCredentials(input: string): Promise<PitchCredentials> {
  const canonical = validatePitchNumber(input);
  const encoder = new TextEncoder();
  const [roomDigest, password] = await Promise.all([
    sha256Hex(encoder.encode(`barrow-alley:room:v1:${canonical}`)),
    sha256Hex(encoder.encode(`barrow-alley:password:v1:${canonical}`)),
  ]);
  return {
    roomId: `barrow-alley-${roomDigest}`,
    password,
  };
}
