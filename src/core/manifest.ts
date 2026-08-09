/**
 * A file entry disclosed only after sender acceptance.
 *
 * `id` is a session-scoped opaque identifier. It must never be a host path or
 * another stable source identifier. `hash` is verified against the sender's
 * current source snapshot and the complete received bytes.
 */
export interface ManifestItem {
    /** Opaque identifier generated afresh for this sender session. */
    readonly id: string;
    /** Minimal safe name shown to the receiver; never an absolute or Vault path. */
    readonly displayName: string;
    /** Declared byte length verified against sent and received bytes. */
    readonly size: number;
    /** Optional media type supplied by the source host. */
    readonly mimeType?: string;
    /** Lower-case SHA-256 hex verified before destination completion. */
    readonly hash: string;
}
