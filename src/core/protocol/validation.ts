import type { ManifestItem } from "../manifest.js";
import { ProtocolValidationError } from "./errors.js";
import type { ClientKind, DenyReason, ErrorCode, ProtocolMessage } from "./messages.js";
import { BARROW_ALLEY_PROTOCOL_VERSION } from "./version.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES, MAX_TRANSFER_CHUNK_SIZE_BYTES } from "../transfer/limits.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

const CLIENT_KINDS = new Set<ClientKind>(["obsidian", "browser"]);
const DENY_REASONS = new Set<DenyReason>(["denied", "busy", "incompatible"]);
const ERROR_CODES = new Set<ErrorCode>([
    "INVALID_MESSAGE",
    "INCOMPATIBLE_PROTOCOL",
    "BUSY",
    "UNKNOWN_FILE",
    "SESSION_CLOSED",
    "SOURCE_CHANGED",
    "TRANSFER_CANCELLED",
    "TRANSFER_FAILED",
    "SIZE_MISMATCH",
    "HASH_MISMATCH",
    "DESTINATION_FAILED",
]);
// The parser validates representation; the transfer layer compares the digest
// with the complete source and received byte arrays.
const SHA_256_HEX = /^[0-9a-f]{64}$/u;

function invalid(message: string): never {
    throw new ProtocolValidationError("INVALID_MESSAGE", message);
}

function asRecord(value: unknown, label: string): UnknownRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return invalid(`${label} must be an object.`);
    }
    return value as UnknownRecord;
}

function asNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        return invalid(`${label} must be a non-empty string.`);
    }
    return value;
}

function asOptionalNonEmptyString(value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : asNonEmptyString(value, label);
}

function asNonNegativeSafeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        return invalid(`${label} must be a non-negative safe integer.`);
    }
    return value as number;
}

function asFileSize(value: unknown, label: string): number {
    const size = asNonNegativeSafeInteger(value, label);
    if (size > MAX_BUFFERED_FILE_SIZE_BYTES) {
        return invalid(`${label} exceeds the buffered file-size limit.`);
    }
    return size;
}

function asPositiveChunkSize(value: unknown): number {
    const size = asNonNegativeSafeInteger(value, "chunkSize");
    if (size === 0 || size > MAX_TRANSFER_CHUNK_SIZE_BYTES) {
        return invalid("chunkSize is outside the supported range.");
    }
    return size;
}

function asSha256(value: unknown, label: string): string {
    const hash = asNonEmptyString(value, label).toLowerCase();
    if (!SHA_256_HEX.test(hash)) return invalid(`${label} must be a SHA-256 hexadecimal string.`);
    return hash;
}

function asClientKind(value: unknown): ClientKind {
    if (typeof value !== "string" || !CLIENT_KINDS.has(value as ClientKind)) {
        return invalid("clientKind is invalid.");
    }
    return value as ClientKind;
}

function asManifestItem(value: unknown, index: number): ManifestItem {
    const item = asRecord(value, `items[${index}]`);
    const id = asNonEmptyString(item.id, `items[${index}].id`);
    const displayName = asNonEmptyString(item.displayName, `items[${index}].displayName`);
    const size = asFileSize(item.size, `items[${index}].size`);
    const hash = asSha256(item.hash, `items[${index}].hash`);
    const mimeType = asOptionalNonEmptyString(item.mimeType, `items[${index}].mimeType`);
    const base = { id, displayName, size, hash };
    return mimeType === undefined ? base : { ...base, mimeType };
}

function asManifestItems(value: unknown): readonly ManifestItem[] {
    if (!Array.isArray(value)) return invalid("items must be an array.");
    const items = value.map((item, index) => asManifestItem(item, index));
    // Requests name files only by manifest ID, so ambiguity here would undermine
    // both file selection and the authorised-peer checks in the sender session.
    if (new Set(items.map((item) => item.id)).size !== items.length) {
        return invalid("Manifest item IDs must be unique.");
    }
    return items;
}

function requireCurrentVersion(value: unknown): number {
    if (!Number.isSafeInteger(value)) return invalid("protocolVersion must be a safe integer.");
    if (value !== BARROW_ALLEY_PROTOCOL_VERSION) {
        throw new ProtocolValidationError(
            "INCOMPATIBLE_PROTOCOL",
            `Protocol version ${String(value)} is incompatible.`,
        );
    }
    return value;
}

/**
 * Parses a peer-level control message at the trust boundary.
 *
 * The returned object is reconstructed from validated fields rather than cast in
 * place. This keeps unchecked peer properties out of the domain state even when
 * a transport supplies ordinary JavaScript objects.
 */
export function parseProtocolMessage(value: unknown): ProtocolMessage {
    const message = asRecord(value, "Message");
    const protocolVersion = requireCurrentVersion(message.protocolVersion);
    const type = asNonEmptyString(message.type, "type");

    switch (type) {
        case "hello":
            return { type, protocolVersion, clientKind: asClientKind(message.clientKind) };
        case "connection-request":
            return { type, protocolVersion, clientKind: asClientKind(message.clientKind) };
        case "accept":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
            };
        case "deny": {
            if (
                message.reason !== undefined &&
                (typeof message.reason !== "string" ||
                    !DENY_REASONS.has(message.reason as DenyReason))
            ) {
                return invalid("reason is invalid.");
            }
            const reason = message.reason as DenyReason | undefined;
            return reason === undefined
                ? { type, protocolVersion }
                : { type, protocolVersion, reason };
        }
        case "manifest":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                items: asManifestItems(message.items),
            };
        case "request-file":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                fileId: asNonEmptyString(message.fileId, "fileId"),
            };
        case "file-begin":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                fileId: asNonEmptyString(message.fileId, "fileId"),
                displayName: asNonEmptyString(message.displayName, "displayName"),
                size: asFileSize(message.size, "size"),
                hash: asSha256(message.hash, "hash"),
                chunkSize: asPositiveChunkSize(message.chunkSize),
            };
        case "file-chunk": {
            if (!(message.data instanceof Uint8Array) || message.data.byteLength === 0) {
                return invalid("data must be a non-empty Uint8Array.");
            }
            if (message.data.byteLength > MAX_TRANSFER_CHUNK_SIZE_BYTES) {
                return invalid("data exceeds the maximum chunk size.");
            }
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                fileId: asNonEmptyString(message.fileId, "fileId"),
                index: asNonNegativeSafeInteger(message.index, "index"),
                offset: asNonNegativeSafeInteger(message.offset, "offset"),
                data: message.data.slice(),
            };
        }
        case "file-end":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                fileId: asNonEmptyString(message.fileId, "fileId"),
                bytesSent: asFileSize(message.bytesSent, "bytesSent"),
                hash: asSha256(message.hash, "hash"),
            };
        case "cancel-file":
            return {
                type,
                protocolVersion,
                sessionId: asNonEmptyString(message.sessionId, "sessionId"),
                fileId: asNonEmptyString(message.fileId, "fileId"),
            };
        case "cancel-session": {
            const sessionId = asOptionalNonEmptyString(message.sessionId, "sessionId");
            return sessionId === undefined
                ? { type, protocolVersion }
                : { type, protocolVersion, sessionId };
        }
        case "error": {
            if (typeof message.code !== "string" || !ERROR_CODES.has(message.code as ErrorCode)) {
                return invalid("code is invalid.");
            }
            return { type, protocolVersion, code: message.code as ErrorCode };
        }
        default:
            return invalid(`Unknown message type: ${type}.`);
    }
}
