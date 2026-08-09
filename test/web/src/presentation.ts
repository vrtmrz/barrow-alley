import type { ErrorCode } from "../../../src/core/protocol/messages.js";
import type { ReceiverState, SenderState } from "../../../src/core/session/state.js";
import { presentRtcDiagnostic } from "../../../src/transport/rtc-diagnostic-presentation.js";
import type { RtcDiagnosticEvent } from "../../../src/transport/rtc-diagnostics.js";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** Formats an exact byte count without implying transfer precision beyond bytes. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1_024) return `${String(bytes)} B`;
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1_024 && unitIndex < BYTE_UNITS.length - 1) {
        value /= 1_024;
        unitIndex += 1;
    }
    const digits = value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}

/** Clear sender lifecycle copy; protocol state names remain internal. */
export function senderStatus(state: SenderState): string {
    const statuses: Record<SenderState, string> = {
        idle: "Ready to set up a pitch.",
        preparing: "Preparing the selected files…",
        "waiting-for-peer": "Waiting for a visitor…",
        "approval-pending": "A visitor is asking to see the files.",
        connected: "Visitor accepted. Sharing the file list…",
        serving: "The visitor can choose a file.",
        transferring: "Sending the requested file…",
        failed: "The pitch stopped because of an error.",
        closing: "Closing the pitch…",
        closed: "The pitch is closed.",
    };
    return statuses[state];
}

/** Clear receiver lifecycle copy; approval and verification stay explicit. */
export function receiverStatus(state: ReceiverState): string {
    const statuses: Record<ReceiverState, string> = {
        idle: "Ready to enter a Pitch number.",
        connecting: "Connecting to the sender…",
        "awaiting-approval": "Waiting for the sender to accept this visit…",
        denied: "The sender denied this visit.",
        "loading-manifest": "Accepted. Loading the file list…",
        browsing: "Choose a file to download.",
        receiving: "Receiving the selected file…",
        failed: "The visit stopped because of an error.",
        closing: "Leaving the pitch…",
        closed: "The pitch is closed.",
    };
    return statuses[state];
}

/** Maps peer-safe protocol codes to actionable browser copy. */
export function peerErrorMessage(code: ErrorCode): string {
    const messages: Record<ErrorCode, string> = {
        INVALID_MESSAGE: "The sender sent a message this client could not understand.",
        INCOMPATIBLE_PROTOCOL: "The sender uses an incompatible Barrow Alley protocol.",
        BUSY: "The sender is already transferring another file.",
        UNKNOWN_FILE: "That file is no longer available from this pitch.",
        SESSION_CLOSED: "The sender has closed this pitch.",
        SOURCE_CHANGED: "The selected file changed. The sender must set up a new pitch.",
        TRANSFER_CANCELLED: "The transfer was cancelled.",
        TRANSFER_FAILED: "The file transfer failed.",
        SIZE_MISMATCH: "The received file size did not match the file list.",
        HASH_MISMATCH: "The received file did not pass its integrity check.",
        DESTINATION_FAILED: "The browser could not prepare the download.",
    };
    return messages[code];
}

/** Sanitises RTC detail and applies the role name used on this page. */
export function rtcStatus(
    event: RtcDiagnosticEvent,
    role: "sender" | "receiver",
): ReturnType<typeof presentRtcDiagnostic> {
    return presentRtcDiagnostic(event, role === "sender" ? "visitor" : "sender");
}

/** Keeps unknown exception details out of the persistent browser interface. */
export function browserErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        switch (error.name) {
            case "PitchNumberError":
            case "RelaySettingsError":
            case "BrowserFileSourceError":
            case "BrowserDownloadSinkError":
            case "ConnectionError":
                return error.message;
            case "TransferError":
            case "SessionError":
                return "The current transfer could not be completed.";
            default:
                break;
        }
    }
    return "Barrow Alley could not complete that action.";
}
