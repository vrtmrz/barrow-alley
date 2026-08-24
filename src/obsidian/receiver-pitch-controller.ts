import type { IncomingFileMeta, Sink } from "../core/files.js";
import {
    derivePitchCredentials,
    formatPitchNumber,
    validatePitchNumber,
} from "../core/pitch-number.js";
import type { RelaySettings } from "../core/settings.js";
import { ReceiverSession } from "../core/session/receiver-session.js";
import type { ReceiverState } from "../core/session/state.js";
import type { TransferProgress } from "../core/transfer/progress.js";
import type { RtcDiagnosticEvent, RtcDiagnosticObserver } from "../transport/rtc-diagnostics.js";
import type { PeerAwareTransport } from "../transport/trystero-transport.js";
import type { TrysteroTransportOptions } from "../transport/trystero-transport.js";

/** Host-owned destination policy paired with the sink used by the core session. */
export interface ReceiverDestination {
    readonly sink: Sink;
    /**
     * Resolves conflicts before bytes are requested.
     *
     * @returns `true` after a safe destination is prepared, or `false` when the
     * user chose skip or cancel and no request should be sent.
     */
    prepare(meta: IncomingFileMeta): Promise<boolean>;
}

/** Immutable receiver information shown while joining one pitch. */
export interface ReceiverPitchViewModel {
    readonly pitchNumber: string;
    readonly destination: string;
}

/** User actions emitted by the persistent receiver UI. */
export interface ReceiverPitchViewActions {
    /** Requests one disclosed manifest item after destination conflict handling. */
    readonly onRequestFile: (fileId: string) => Promise<void>;
    /** Cancels the one active file without closing the accepted pitch. */
    readonly onCancelFile: () => Promise<void>;
    /** Closes this attempt and returns to host-owned Pitch-number entry. */
    readonly onRetry: () => Promise<void>;
    /** Ends the receiver session because its owning UI has closed. */
    readonly onClose: () => Promise<void>;
}

/** Presentation boundary kept free of Obsidian and DOM dependencies for tests. */
export interface ReceiverPitchView {
    open(): void;
    close(): void;
    setState(state: ReceiverState): void;
    setManifest(items: readonly IncomingFileMeta[]): void;
    setProgress(progress: TransferProgress): void;
    setRtcDiagnostic(event: RtcDiagnosticEvent): void;
}

export interface ReceiverPitchControllerOptions {
    /** Creates the one peer-discovering transport owned by each receive attempt. */
    readonly createTransport: (
        options: TrysteroTransportOptions,
        onRtcDiagnostic: RtcDiagnosticObserver,
    ) => Promise<PeerAwareTransport>;
    /** Creates the persistent host UI before peer discovery starts. */
    readonly createView: (
        model: ReceiverPitchViewModel,
        actions: ReceiverPitchViewActions,
    ) => ReceiverPitchView;
    /** Reopens host-owned number entry after a denied or failed attempt. */
    readonly onRetryRequested?: () => void | Promise<void>;
}

interface ActiveReceiver {
    /**
     * The session may already be closed when a failed attempt remains visible.
     * Keeping the pair active preserves ownership of the retryable view.
     */
    readonly session: ReceiverSession;
    readonly view: ReceiverPitchView;
}

/**
 * Owns the single active Obsidian receiver session and its presentation lifecycle.
 *
 * Pitch-number entry, folder choice, and conflict questions stay in the host
 * adapter. This controller owns peer discovery, admission, manifest exposure,
 * file requests, cancellation, and deterministic transport cleanup.
 */
export class ReceiverPitchController {
    readonly #options: ReceiverPitchControllerOptions;
    #active: ActiveReceiver | undefined;
    #operations: Promise<void> = Promise.resolve();
    #shutDown = false;

    constructor(options: ReceiverPitchControllerOptions) {
        this.#options = options;
    }

    get hasActiveReceiver(): boolean {
        return this.#active !== undefined;
    }

    /** Derives room credentials, discovers the sender, and requests admission. */
    receivePitch(
        pitchNumberInput: string,
        destination: ReceiverDestination,
        destinationLabel: string,
        relaySettings: RelaySettings,
        onRetryRequested?: () => void | Promise<void>,
    ): Promise<string> {
        if (this.#shutDown) return Promise.reject(controllerShutDownError());
        return this.#enqueue(async () =>
            this.#performReceive(
                pitchNumberInput,
                destination,
                destinationLabel,
                relaySettings,
                onRetryRequested,
            )
        );
    }

    /** Closes the active receiver and its UI. Repeated calls are harmless. */
    closeActiveReceiver(): Promise<void> {
        return this.#enqueue(async () => this.#performCloseActive(true));
    }

    /** Permanently rejects new work and closes resources for plug-in unload. */
    shutdown(): Promise<void> {
        this.#shutDown = true;
        return this.#enqueue(async () => this.#performCloseActive(true));
    }

    async #performReceive(
        pitchNumberInput: string,
        destination: ReceiverDestination,
        destinationLabel: string,
        relaySettings: RelaySettings,
        onRetryRequested: (() => void | Promise<void>) | undefined,
    ): Promise<string> {
        this.#assertRunning();
        await this.#performCloseActive(true);
        const pitchNumber = validatePitchNumber(pitchNumberInput);
        const credentials = await derivePitchCredentials(pitchNumber);
        this.#assertRunning();

        let view: ReceiverPitchView | undefined;
        let viewOpened = false;
        let latestRtcDiagnostic: RtcDiagnosticEvent | undefined;
        const transport = await this.#options.createTransport(
            {
                roomId: credentials.roomId,
                password: credentials.password,
                relays: [...relaySettings.relays],
            },
            (event) => {
                latestRtcDiagnostic = event;
                const currentView = view;
                if (
                    viewOpened && currentView !== undefined &&
                    this.#active?.view === currentView
                ) {
                    currentView.setRtcDiagnostic(event);
                }
            },
        );
        if (this.#shutDown) {
            await transport.close();
            throw controllerShutDownError();
        }

        let session: ReceiverSession | undefined;
        try {
            const actions: ReceiverPitchViewActions = {
                onRequestFile: async (fileId) => {
                    const current = requireSession(session);
                    const meta = current.manifest?.find((item) => item.id === fileId);
                    if (meta === undefined) {
                        throw new Error("That file is not in the pitch.");
                    }
                    if (await destination.prepare(meta)) {
                        await current.requestFile(fileId);
                    }
                },
                onCancelFile: async () => requireSession(session).cancelFile(),
                onRetry: async () => {
                    const current = requireSession(session);
                    await this.#enqueue(async () => this.#performClose(current, true));
                    await (onRetryRequested ?? this.#options.onRetryRequested)?.();
                },
                onClose: async () => {
                    const current = requireSession(session);
                    await this.#enqueue(async () => this.#performClose(current, false));
                },
            };
            const receiverView = this.#options.createView(
                {
                    pitchNumber: formatPitchNumber(pitchNumber),
                    destination: destinationLabel,
                },
                actions,
            );
            view = receiverView;
            session = new ReceiverSession({
                clientKind: "obsidian",
                sink: destination.sink,
                transport,
                onStateChange(state) {
                    receiverView.setState(state);
                    if (state === "browsing") {
                        const manifest = requireSession(session).manifest;
                        if (manifest !== undefined) {
                            receiverView.setManifest(manifest);
                        }
                    }
                },
                onProgress(progress) {
                    receiverView.setProgress(progress);
                },
            });
        } catch (error) {
            await transport.close();
            throw error;
        }

        this.#active = { session, view };
        try {
            view.open();
            viewOpened = true;
            if (latestRtcDiagnostic !== undefined) {
                view.setRtcDiagnostic(latestRtcDiagnostic);
            }
            const senderPeerId = await transport.waitForPeer();
            this.#assertRunning();
            await session.connect(senderPeerId);
            return pitchNumber;
        } catch (error) {
            if (this.#shutDown) {
                await this.#performClose(session, true);
            } else {
                // Discovery and admission failures must release the transport,
                // but the visible attempt remains useful: it explains the
                // failure and provides the route back to number entry.
                await session.close();
                if (this.#active?.session === session) {
                    view.setState("failed");
                }
            }
            throw error;
        }
    }

    async #performCloseActive(closeView: boolean): Promise<void> {
        if (this.#active === undefined) return;
        await this.#performClose(this.#active.session, closeView);
    }

    async #performClose(
        session: ReceiverSession,
        closeView: boolean,
    ): Promise<void> {
        const active = this.#active;
        if (active === undefined || active.session !== session) return;
        this.#active = undefined;
        await active.session.close();
        if (closeView) active.view.close();
    }

    #enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#operations.then(operation, operation);
        this.#operations = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    #assertRunning(): void {
        if (this.#shutDown) throw controllerShutDownError();
    }
}

function requireSession(session: ReceiverSession | undefined): ReceiverSession {
    if (session === undefined) {
        throw new Error("The receiver session is not ready.");
    }
    return session;
}

function controllerShutDownError(): Error {
    return new Error("The Barrow Alley receiver controller has shut down.");
}
