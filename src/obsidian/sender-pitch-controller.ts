import {
    derivePitchCredentials,
    formatPitchNumber,
    generatePitchNumber,
} from "../core/pitch-number.js";
import { compatGlobal } from "../compat-global.js";
import type { RelaySettings } from "../core/settings.js";
import { SenderSession } from "../core/session/sender-session.js";
import type { SenderState } from "../core/session/state.js";
import type { Source } from "../core/files.js";
import type { TransferProgress } from "../core/transfer/progress.js";
import type { Transport } from "../transport/transport.js";
import type { RtcDiagnosticEvent, RtcDiagnosticObserver } from "../transport/rtc-diagnostics.js";
import type { TrysteroTransportOptions } from "../transport/trystero-transport.js";

/** Immutable sender information shown by the persistent pitch UI. */
export interface SenderPitchViewModel {
    /** Grouped user-facing number, for example `1234 5678`. */
    readonly pitchNumber: string;
    /** Receiver-facing file labels, never Vault paths. */
    readonly files: readonly string[];
}

/** User decisions emitted by one sender pitch UI. */
export interface SenderPitchViewActions {
    /** Admits the sole pending visitor and permits manifest disclosure. */
    readonly onAccept: () => Promise<void>;
    /** Rejects the pending visitor without disclosing the manifest. */
    readonly onDeny: () => Promise<void>;
    /** Ends the pitch because the owning UI has closed. */
    readonly onClose: () => Promise<void>;
}

/** Presentation boundary kept free of Obsidian and DOM dependencies for tests. */
export interface SenderPitchView {
    open(): void;
    close(): void;
    setState(state: SenderState): void;
    setProgress(progress: TransferProgress): void;
    /** Shows sanitised direct-connection progress without changing session state. */
    setRtcDiagnostic(event: RtcDiagnosticEvent): void;
}

export interface SenderPitchControllerOptions {
    /** Creates the one transport owned by each new pitch. */
    readonly createTransport: (
        options: TrysteroTransportOptions,
        onRtcDiagnostic: RtcDiagnosticObserver,
    ) => Promise<Transport>;
    /** Creates the persistent host UI for a prepared pitch. */
    readonly createView: (
        model: SenderPitchViewModel,
        actions: SenderPitchViewActions,
    ) => SenderPitchView;
    /** Injectable secure Pitch-number generator. */
    readonly generateNumber?: () => string;
    /** Injectable opaque protocol-session ID generator. */
    readonly createSessionId?: () => string;
}

interface ActivePitch {
    readonly session: SenderSession;
    readonly view: SenderPitchView;
}

/**
 * Owns the single active Obsidian sender pitch and its UI lifecycle.
 *
 * Work is serialised so two rapid commands cannot leave two rooms active. A UI
 * close releases the session, while an owner close (replacement or plug-in
 * unload) releases the session and then dismisses the UI.
 */
export class SenderPitchController {
    readonly #options: SenderPitchControllerOptions;
    #active: ActivePitch | undefined;
    #operations: Promise<void> = Promise.resolve();
    #shutDown = false;

    constructor(options: SenderPitchControllerOptions) {
        this.#options = options;
    }

    get hasActivePitch(): boolean {
        return this.#active !== undefined;
    }

    /** Prepares files, creates a room, and opens the sender UI. */
    setUpPitch(source: Source, relaySettings: RelaySettings): Promise<string> {
        if (this.#shutDown) return Promise.reject(controllerShutDownError());
        return this.#enqueue(async () => this.#performSetUp(source, relaySettings));
    }

    /** Closes the active session and its UI. Repeated calls are harmless. */
    closeActivePitch(): Promise<void> {
        return this.#enqueue(async () => this.#performCloseActive(true));
    }

    /** Permanently rejects new work and closes resources for plug-in unload. */
    shutdown(): Promise<void> {
        this.#shutDown = true;
        return this.#enqueue(async () => this.#performCloseActive(true));
    }

    async #performSetUp(source: Source, relaySettings: RelaySettings): Promise<string> {
        this.#assertRunning();
        await this.#performCloseActive(true);
        const sourceItems = await source.list();
        this.#assertRunning();
        const pitchNumber = (this.#options.generateNumber ?? generatePitchNumber)();
        const credentials = await derivePitchCredentials(pitchNumber);
        this.#assertRunning();
        let view: SenderPitchView | undefined;
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
                // Ignore late close events once this pitch no longer owns the view.
                const currentView = view;
                if (viewOpened && currentView !== undefined && this.#active?.view === currentView) {
                    currentView.setRtcDiagnostic(event);
                }
            },
        );
        if (this.#shutDown) {
            await transport.close();
            throw controllerShutDownError();
        }

        let session: SenderSession | undefined;
        try {
            const actions: SenderPitchViewActions = {
                onAccept: async () => requireSession(session).accept(),
                onDeny: async () => requireSession(session).deny(),
                onClose: async () => {
                    const current = requireSession(session);
                    await this.#enqueue(async () => this.#performClose(current, false));
                },
            };
            const pitchView = this.#options.createView(
                {
                    pitchNumber: formatPitchNumber(pitchNumber),
                    files: sourceItems.map(({ displayName }) => displayName),
                },
                actions,
            );
            view = pitchView;
            session = new SenderSession({
                sessionId: (this.#options.createSessionId ?? createSessionId)(),
                source,
                transport,
                onStateChange(state) {
                    pitchView.setState(state);
                },
                onProgress(progress) {
                    pitchView.setProgress(progress);
                },
            });
        } catch (error) {
            await transport.close();
            throw error;
        }

        const active = { session, view };
        this.#active = active;
        try {
            view.open();
            viewOpened = true;
            if (latestRtcDiagnostic !== undefined) {
                view.setRtcDiagnostic(latestRtcDiagnostic);
            }
            await session.start();
            this.#assertRunning();
            return pitchNumber;
        } catch (error) {
            await this.#performClose(session, true);
            throw error;
        }
    }

    async #performCloseActive(closeView: boolean): Promise<void> {
        if (this.#active === undefined) return;
        await this.#performClose(this.#active.session, closeView);
    }

    async #performClose(session: SenderSession, closeView: boolean): Promise<void> {
        const active = this.#active;
        if (active === undefined || active.session !== session) return;
        // Clear ownership first so Modal.onClose cannot recursively close the same
        // active record when an owner-triggered dismissal reaches the host.
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

function requireSession(session: SenderSession | undefined): SenderSession {
    if (session === undefined) throw new Error("The sender session is not ready.");
    return session;
}

function createSessionId(): string {
    return compatGlobal.crypto.randomUUID();
}

function controllerShutDownError(): Error {
    return new Error("The Barrow Alley sender controller has shut down.");
}
