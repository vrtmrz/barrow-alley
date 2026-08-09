import { compatGlobal } from "../../../src/compat-global.js";
import type { Sink, Source } from "../../../src/core/files.js";
import type { ManifestItem } from "../../../src/core/manifest.js";
import {
    derivePitchCredentials,
    formatPitchNumber,
    generatePitchNumber,
    validatePitchNumber,
} from "../../../src/core/pitch-number.js";
import type { ErrorCode } from "../../../src/core/protocol/messages.js";
import type { RelaySettings } from "../../../src/core/settings.js";
import { ReceiverSession } from "../../../src/core/session/receiver-session.js";
import { SenderSession } from "../../../src/core/session/sender-session.js";
import type { ReceiverState, SenderState } from "../../../src/core/session/state.js";
import type { TransferProgress } from "../../../src/core/transfer/progress.js";
import type {
    RtcDiagnosticEvent,
    RtcDiagnosticObserver,
} from "../../../src/transport/rtc-diagnostics.js";
import type {
    PeerAwareTransport,
    TrysteroTransportOptions,
} from "../../../src/transport/trystero-transport.js";

/** Minimal safe source detail rendered before a browser pitch is opened. */
export interface BrowserPresentedFile {
    readonly displayName: string;
    readonly size: number;
}

export interface IdleBrowserPitchSnapshot {
    readonly mode: "idle";
}

export interface SenderBrowserPitchSnapshot {
    readonly mode: "sender";
    readonly pitchNumber: string;
    readonly files: readonly BrowserPresentedFile[];
    readonly state: SenderState;
    readonly progress?: TransferProgress;
    readonly rtcDiagnostic?: RtcDiagnosticEvent;
}

export interface ReceiverBrowserPitchSnapshot {
    readonly mode: "receiver";
    readonly pitchNumber: string;
    readonly state: ReceiverState;
    readonly manifest: readonly ManifestItem[];
    readonly peerError?: ErrorCode;
    readonly progress?: TransferProgress;
    readonly rtcDiagnostic?: RtcDiagnosticEvent;
}

/** Complete immutable state published to the persistent Svelte presentation. */
export type BrowserPitchSnapshot =
    | IdleBrowserPitchSnapshot
    | SenderBrowserPitchSnapshot
    | ReceiverBrowserPitchSnapshot;

export type BrowserPitchObserver = (snapshot: BrowserPitchSnapshot) => void;

export interface BrowserPitchControllerOptions {
    /** Creates one Trystero transport with peer discovery for either browser role. */
    readonly createTransport: (
        options: TrysteroTransportOptions,
        onRtcDiagnostic: RtcDiagnosticObserver,
    ) => Promise<PeerAwareTransport>;
    /** Receives every immutable presentation snapshot. */
    readonly onChange?: BrowserPitchObserver;
    /** Injectable secure Pitch-number generator. */
    readonly generateNumber?: () => string;
    /** Injectable opaque protocol-session ID generator. */
    readonly createSessionId?: () => string;
}

export type BrowserPitchControllerErrorCode = "CANCELLED" | "INVALID_ROLE" | "SHUT_DOWN";

/** Stable lifecycle failure which lets page code ignore intentional cancellation. */
export class BrowserPitchControllerError extends Error {
    readonly code: BrowserPitchControllerErrorCode;

    constructor(code: BrowserPitchControllerErrorCode, message: string) {
        super(message);
        this.name = "BrowserPitchControllerError";
        this.code = code;
    }
}

interface ActiveSender {
    readonly mode: "sender";
    readonly session: SenderSession;
}

interface ActiveReceiver {
    readonly mode: "receiver";
    readonly session: ReceiverSession;
    readonly discoveryAbort: AbortController;
}

type ActiveBrowserPitch = ActiveSender | ActiveReceiver;

/**
 * Owns the browser page's sole sender or receiver session.
 *
 * Long peer discovery is abortable outside the setup Promise, so a close button,
 * component teardown, `pagehide`, or `beforeunload` can immediately start cleanup.
 * An attempt token prevents late file reads or transport creation from reclaiming
 * the page after the user has closed or replaced that attempt.
 */
export class BrowserPitchController {
    readonly #options: BrowserPitchControllerOptions;
    #snapshot: BrowserPitchSnapshot = { mode: "idle" };
    #active: ActiveBrowserPitch | undefined;
    #attempt = 0;
    #shutDown = false;

    constructor(options: BrowserPitchControllerOptions) {
        this.#options = options;
    }

    get snapshot(): BrowserPitchSnapshot {
        return this.#snapshot;
    }

    /** Hashes selected browser files and opens a new sender pitch. */
    async setUpPitch(source: Source, relaySettings: RelaySettings): Promise<string> {
        this.#assertRunning();
        const attempt = ++this.#attempt;
        await this.#closeOwnedActive();
        const sourceItems = await source.list();
        this.#assertCurrent(attempt);
        const pitchNumber = (this.#options.generateNumber ?? generatePitchNumber)();
        const credentials = await derivePitchCredentials(pitchNumber);
        this.#assertCurrent(attempt);
        let latestRtcDiagnostic: RtcDiagnosticEvent | undefined;
        let active: ActiveSender | undefined;
        const transport = await this.#options.createTransport(
            {
                roomId: credentials.roomId,
                password: credentials.password,
                relays: [...relaySettings.relays],
            },
            (event) => {
                latestRtcDiagnostic = event;
                if (active !== undefined && this.#active === active) {
                    this.#updateSender(active, { rtcDiagnostic: event });
                }
            },
        );
        if (!this.#isCurrent(attempt)) {
            await transport.close();
            throw cancelledError();
        }

        let session: SenderSession | undefined;
        try {
            session = new SenderSession({
                sessionId: (this.#options.createSessionId ?? createSessionId)(),
                source,
                transport,
                onStateChange: (state) => {
                    const current = active;
                    if (current !== undefined && this.#active === current) {
                        this.#updateSender(current, { state });
                    }
                },
                onProgress: (progress) => {
                    const current = active;
                    if (current !== undefined && this.#active === current) {
                        this.#updateSender(current, { progress });
                    }
                },
            });
            active = { mode: "sender", session };
            this.#active = active;
            this.#publish({
                mode: "sender",
                pitchNumber: formatPitchNumber(pitchNumber),
                files: sourceItems.map(({ displayName, size }) => ({ displayName, size })),
                state: session.state,
                ...(latestRtcDiagnostic === undefined
                    ? {}
                    : { rtcDiagnostic: latestRtcDiagnostic }),
            });
            await session.start();
            this.#assertCurrent(attempt);
            return pitchNumber;
        } catch (error) {
            if (active !== undefined && this.#active === active) await this.#closeOwnedActive();
            else await transport.close();
            throw error;
        }
    }

    /** Joins a sender room and requests admission for a browser download sink. */
    async receivePitch(
        pitchNumberInput: string,
        sink: Sink,
        relaySettings: RelaySettings,
    ): Promise<string> {
        this.#assertRunning();
        const attempt = ++this.#attempt;
        await this.#closeOwnedActive();
        const pitchNumber = validatePitchNumber(pitchNumberInput);
        const credentials = await derivePitchCredentials(pitchNumber);
        this.#assertCurrent(attempt);
        let latestRtcDiagnostic: RtcDiagnosticEvent | undefined;
        let active: ActiveReceiver | undefined;
        const transport = await this.#options.createTransport(
            {
                roomId: credentials.roomId,
                password: credentials.password,
                relays: [...relaySettings.relays],
            },
            (event) => {
                latestRtcDiagnostic = event;
                if (active !== undefined && this.#active === active) {
                    this.#updateReceiver(active, { rtcDiagnostic: event });
                }
            },
        );
        if (!this.#isCurrent(attempt)) {
            await transport.close();
            throw cancelledError();
        }

        const discoveryAbort = new AbortController();
        let session: ReceiverSession | undefined;
        try {
            session = new ReceiverSession({
                clientKind: "browser",
                sink,
                transport,
                onStateChange: (state) => {
                    const current = active;
                    if (current !== undefined && this.#active === current) {
                        this.#updateReceiver(current, {
                            state,
                            manifest: session?.manifest ?? [],
                            ...(session?.peerError === undefined
                                ? {}
                                : { peerError: session.peerError }),
                        });
                    }
                },
                onProgress: (progress) => {
                    const current = active;
                    if (current !== undefined && this.#active === current) {
                        this.#updateReceiver(current, { progress });
                    }
                },
            });
            active = { mode: "receiver", session, discoveryAbort };
            this.#active = active;
            this.#publish({
                mode: "receiver",
                pitchNumber: formatPitchNumber(pitchNumber),
                state: session.state,
                manifest: [],
                ...(latestRtcDiagnostic === undefined
                    ? {}
                    : { rtcDiagnostic: latestRtcDiagnostic }),
            });
            const senderPeerId = await transport.waitForPeer({ signal: discoveryAbort.signal });
            this.#assertCurrent(attempt);
            await session.connect(senderPeerId);
            return pitchNumber;
        } catch (error) {
            // Record cancellation before cleanup aborts the discovery controller.
            // Otherwise an ordinary timeout is misclassified as a user close.
            const cancelled = !this.#isCurrent(attempt) || discoveryAbort.signal.aborted;
            if (active !== undefined && this.#active === active) await this.#closeOwnedActive();
            else await transport.close();
            if (cancelled) throw cancelledError();
            this.#publish({ mode: "idle" });
            throw error;
        }
    }

    /** Accepts the sole visitor currently awaiting sender approval. */
    async accept(): Promise<void> {
        await this.#requireSender().session.accept();
    }

    /** Denies the pending visitor without disclosing the manifest. */
    async deny(): Promise<void> {
        await this.#requireSender().session.deny();
    }

    /** Requests one manifest item and starts its verified browser download. */
    async requestFile(fileId: string): Promise<void> {
        await this.#requireReceiver().session.requestFile(fileId);
    }

    /** Cancels one active browser download while retaining the accepted manifest. */
    async cancelFile(): Promise<void> {
        await this.#requireReceiver().session.cancelFile();
    }

    /** Stops the active role and returns the page to its idle chooser. */
    async closeActive(): Promise<void> {
        this.#attempt += 1;
        await this.#closeOwnedActive();
        this.#publish({ mode: "idle" });
    }

    /** Permanently rejects new work and releases page-owned transport resources. */
    async shutdown(): Promise<void> {
        if (this.#shutDown) return;
        this.#shutDown = true;
        this.#attempt += 1;
        await this.#closeOwnedActive();
        this.#publish({ mode: "idle" });
    }

    #updateSender(
        active: ActiveSender,
        patch: Partial<Omit<SenderBrowserPitchSnapshot, "mode" | "pitchNumber" | "files">>,
    ): void {
        if (this.#active !== active || this.#snapshot.mode !== "sender") return;
        this.#publish({ ...this.#snapshot, ...patch });
    }

    #updateReceiver(
        active: ActiveReceiver,
        patch: Partial<Omit<ReceiverBrowserPitchSnapshot, "mode" | "pitchNumber">>,
    ): void {
        if (this.#active !== active || this.#snapshot.mode !== "receiver") return;
        this.#publish({ ...this.#snapshot, ...patch });
    }

    #publish(snapshot: BrowserPitchSnapshot): void {
        this.#snapshot = snapshot;
        try {
            this.#options.onChange?.(snapshot);
        } catch {
            // Presentation observers cannot interrupt protocol or cleanup work.
        }
    }

    async #closeOwnedActive(): Promise<void> {
        const active = this.#active;
        if (active === undefined) return;
        this.#active = undefined;
        if (active.mode === "receiver") active.discoveryAbort.abort(cancelledError());
        await active.session.close();
    }

    #requireSender(): ActiveSender {
        if (this.#active?.mode !== "sender") {
            throw new BrowserPitchControllerError(
                "INVALID_ROLE",
                "No browser sender pitch is active.",
            );
        }
        return this.#active;
    }

    #requireReceiver(): ActiveReceiver {
        if (this.#active?.mode !== "receiver") {
            throw new BrowserPitchControllerError(
                "INVALID_ROLE",
                "No browser receiver session is active.",
            );
        }
        return this.#active;
    }

    #assertRunning(): void {
        if (this.#shutDown) {
            throw new BrowserPitchControllerError(
                "SHUT_DOWN",
                "The Barrow Alley browser controller has shut down.",
            );
        }
    }

    #assertCurrent(attempt: number): void {
        this.#assertRunning();
        if (!this.#isCurrent(attempt)) throw cancelledError();
    }

    #isCurrent(attempt: number): boolean {
        return !this.#shutDown && this.#attempt === attempt;
    }
}

function createSessionId(): string {
    return compatGlobal.crypto.randomUUID();
}

function cancelledError(): BrowserPitchControllerError {
    return new BrowserPitchControllerError("CANCELLED", "The browser pitch attempt was closed.");
}
