import type { RelaySettings } from "../core/settings.js";

/** Operational defaults shared by the Obsidian and browser settings adapters. */
export const DEFAULT_RELAY_SETTINGS: RelaySettings = Object.freeze({
  // This relay is also the established Self-hosted LiveSync default. It is an
  // operational choice, not part of the Barrow Alley wire protocol.
  relays: Object.freeze(["wss://exp-relay.vrtmrz.net/"]),
});

export type RelaySettingsErrorCode = "INVALID_RELAY_URL" | "NO_VALID_RELAYS";

/** Describes a relay list which cannot safely become the effective setting. */
export class RelaySettingsError extends Error {
  readonly code: RelaySettingsErrorCode;
  readonly line: number | undefined;

  constructor(code: RelaySettingsErrorCode, message: string, line?: number) {
    super(message);
    this.name = "RelaySettingsError";
    this.code = code;
    this.line = line;
  }
}

export interface RelayUrlPolicy {
  /**
   * Permits `ws://` for a loopback host in an isolated interoperability test.
   *
   * Production settings must never enable this policy. It exists so a local
   * strfry Compose fixture can exercise discovery without a test TLS endpoint.
   */
  readonly allowInsecureLoopbackForTests?: boolean;
}

/**
 * Parses the complete effective relay list entered by a user.
 *
 * Whitespace and blank lines are presentation concerns, while URL spelling is
 * retained deliberately: only exact duplicates are removed. Rejecting the
 * complete edit, rather than silently dropping invalid lines, keeps the relay
 * set visible and predictable in both hosts.
 */
export function parseRelayUrls(input: string, policy: RelayUrlPolicy = {}): string[] {
  const relays: string[] = [];
  const seen = new Set<string>();

  for (const [index, sourceLine] of input.split(/\r?\n/u).entries()) {
    const relay = sourceLine.trim();
    if (relay.length === 0 || seen.has(relay)) continue;
    validateRelayUrl(relay, index + 1, policy);
    seen.add(relay);
    relays.push(relay);
  }

  if (relays.length === 0) {
    throw new RelaySettingsError(
      "NO_VALID_RELAYS",
      "Enter at least one secure Nostr relay URL.",
    );
  }

  return relays;
}

/** Converts a validated relay list to its one-URL-per-line editor form. */
export function relayUrlsToText(relays: readonly string[]): string {
  return relays.join("\n");
}

function validateRelayUrl(relay: string, line: number, policy: RelayUrlPolicy): void {
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    throw invalidRelay(line, "is not a valid URL");
  }

  const secure = url.protocol === "wss:";
  const permittedLoopback =
    policy.allowInsecureLoopbackForTests === true &&
    url.protocol === "ws:" &&
    isLoopbackHost(url.hostname);

  if (!secure && !permittedLoopback) {
    throw invalidRelay(line, "must use wss://");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalidRelay(line, "must not contain credentials");
  }
  if (url.hash.length > 0) {
    throw invalidRelay(line, "must not contain a fragment");
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function invalidRelay(line: number, problem: string): RelaySettingsError {
  return new RelaySettingsError(
    "INVALID_RELAY_URL",
    `Relay URL on line ${line} ${problem}.`,
    line,
  );
}
