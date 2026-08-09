import { type App, Modal } from "obsidian";
import { ProgressFragment } from "@vrtmrz/obsidian-plugin-kit/progress";

import type { IncomingFileMeta, ReceiverState, TransferProgress } from "../core/index.js";
import type { RtcDiagnosticEvent } from "../transport/rtc-diagnostics.js";
import type {
    ReceiverPitchView,
    ReceiverPitchViewActions,
    ReceiverPitchViewModel,
} from "./receiver-pitch-controller.js";
import { presentRtcDiagnostic } from "./rtc-diagnostic-presentation.js";

/** Persistent Obsidian receiver UI for admission, browsing, and one active transfer. */
export class BarrowAlleyReceiverPitchModal extends Modal implements ReceiverPitchView {
    readonly #model: ReceiverPitchViewModel;
    readonly #actions: ReceiverPitchViewActions;
    readonly #manifest = new Map<string, IncomingFileMeta>();
    readonly #fileButtons = new Map<string, HTMLButtonElement>();
    #statusElement: HTMLParagraphElement | undefined;
    #filesElement: HTMLDivElement | undefined;
    #diagnosticElement: HTMLDivElement | undefined;
    #diagnosticMessageElement: HTMLParagraphElement | undefined;
    #diagnosticTotalsElement: HTMLParagraphElement | undefined;
    #cancelButton: HTMLButtonElement | undefined;
    #retryButton: HTMLButtonElement | undefined;
    #progress: ProgressFragment | undefined;
    #state: ReceiverState = "idle";
    #lastProgress: TransferProgress | undefined;

    constructor(
        app: App,
        model: ReceiverPitchViewModel,
        actions: ReceiverPitchViewActions,
    ) {
        super(app);
        this.#model = model;
        this.#actions = actions;
    }

    override onOpen(): void {
        this.setTitle("Receive files · Barrow Alley");
        const document = this.contentEl.ownerDocument;
        const root = document.createElement("div");
        root.className = "barrow-alley-pitch barrow-alley-receiver";

        const numberHeading = document.createElement("h3");
        numberHeading.textContent = "Pitch No.";
        root.append(numberHeading);
        const number = document.createElement("div");
        number.className = "barrow-alley-pitch__number";
        number.textContent = this.#model.pitchNumber;
        root.append(number);

        const destination = document.createElement("p");
        destination.className = "barrow-alley-pitch__summary";
        destination.textContent = `Save to: ${this.#model.destination}`;
        root.append(destination);

        this.#statusElement = document.createElement("p");
        this.#statusElement.className = "barrow-alley-pitch__status";
        this.#statusElement.textContent = receiverStatus("idle");
        this.#statusElement.setAttribute("role", "status");
        this.#statusElement.setAttribute("aria-live", "polite");
        root.append(this.#statusElement);

        this.#diagnosticElement = document.createElement("div");
        this.#diagnosticElement.className = "barrow-alley-pitch__diagnostic";
        this.#diagnosticElement.hidden = true;
        const diagnosticHeading = document.createElement("strong");
        diagnosticHeading.textContent = "Direct connection";
        this.#diagnosticElement.append(diagnosticHeading);
        this.#diagnosticMessageElement = document.createElement("p");
        this.#diagnosticElement.append(this.#diagnosticMessageElement);
        this.#diagnosticTotalsElement = document.createElement("p");
        this.#diagnosticTotalsElement.className = "barrow-alley-pitch__diagnostic-totals";
        this.#diagnosticElement.append(this.#diagnosticTotalsElement);
        root.append(this.#diagnosticElement);

        const filesHeading = document.createElement("h3");
        filesHeading.textContent = "Available files";
        root.append(filesHeading);
        this.#filesElement = document.createElement("div");
        this.#filesElement.className = "barrow-alley-receiver__files";
        const waiting = document.createElement("p");
        waiting.textContent = "Files appear after the sender accepts.";
        this.#filesElement.append(waiting);
        root.append(this.#filesElement);

        this.#progress = new ProgressFragment({
            document,
            title: "Receiving file",
            note: "Choose a file after the sender accepts.",
            collapsed: true,
            autoComplete: false,
            formatNumeric: ({ value, total }) =>
                total === 0 ? "" : `${formatBytes(value)} / ${formatBytes(total)}`,
        });
        root.append(this.#progress.fragment);

        const footer = document.createElement("div");
        footer.className = "barrow-alley-pitch__footer";
        this.#retryButton = document.createElement("button");
        this.#retryButton.type = "button";
        this.#retryButton.textContent = "Try another number";
        this.#retryButton.hidden = true;
        this.#retryButton.addEventListener("click", () => {
            this.#retryButton?.setAttribute("disabled", "");
            void this.#actions.onRetry().catch((error) => this.#showActionError(error));
        });
        this.#cancelButton = document.createElement("button");
        this.#cancelButton.type = "button";
        this.#cancelButton.textContent = "Cancel transfer";
        this.#cancelButton.hidden = true;
        this.#cancelButton.addEventListener("click", () => {
            this.#cancelButton?.setAttribute("disabled", "");
            void this.#actions.onCancelFile().catch((error) => this.#showActionError(error));
        });
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "Close";
        closeButton.addEventListener("click", () => this.close());
        footer.append(this.#retryButton, this.#cancelButton, closeButton);
        root.append(footer);

        this.contentEl.replaceChildren(root);
    }

    override onClose(): void {
        this.contentEl.empty();
        void this.#actions.onClose().catch(() => undefined);
    }

    setState(state: ReceiverState): void {
        const status = this.#statusElement;
        if (status === undefined) return;
        const previousState = this.#state;
        this.#state = state;
        status.textContent = receiverStatus(state);
        const isError = state === "denied" || state === "failed";
        status.toggleAttribute("data-error", isError);
        status.setAttribute("role", isError ? "alert" : "status");
        if (this.#retryButton !== undefined) {
            this.#retryButton.hidden = state !== "denied" && state !== "failed";
            this.#retryButton.disabled = false;
        }
        if (this.#cancelButton !== undefined) {
            this.#cancelButton.hidden = state !== "receiving";
            this.#cancelButton.disabled = false;
        }
        for (const button of this.#fileButtons.values()) {
            button.disabled = state !== "browsing";
        }
        if (previousState === "receiving" && state === "browsing") {
            const progress = this.#lastProgress;
            const indicator = this.#progress;
            if (progress !== undefined && indicator !== undefined) {
                indicator.update({
                    note: progress.transferredBytes === progress.totalBytes
                        ? "Received, verified, and saved."
                        : "Transfer cancelled. No incomplete file was saved.",
                });
            }
        }
    }

    setManifest(items: readonly IncomingFileMeta[]): void {
        const container = this.#filesElement;
        if (container === undefined) return;
        this.#manifest.clear();
        this.#fileButtons.clear();
        const document = container.ownerDocument;
        const rows = items.map((item) => {
            this.#manifest.set(item.id, item);
            const row = document.createElement("div");
            row.className = "barrow-alley-receiver__file";
            const details = document.createElement("div");
            const name = document.createElement("strong");
            name.textContent = item.displayName;
            const size = document.createElement("span");
            size.textContent = formatBytes(item.size);
            details.append(name, size);
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Receive";
            button.addEventListener("click", () => {
                button.disabled = true;
                void this.#actions.onRequestFile(item.id).catch((error) => {
                    this.#showActionError(error);
                    button.disabled = false;
                });
            });
            this.#fileButtons.set(item.id, button);
            row.append(details, button);
            return row;
        });
        if (rows.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = "This pitch contains no files.";
            container.replaceChildren(empty);
        } else {
            container.replaceChildren(...rows);
        }
    }

    setProgress(progress: TransferProgress): void {
        const indicator = this.#progress;
        if (indicator === undefined) return;
        this.#lastProgress = progress;
        const fileName = this.#manifest.get(progress.fileId)?.displayName ??
            "file";
        indicator.update({
            collapsed: false,
            title: `Receiving ${fileName}`,
            note: progress.transferredBytes === progress.totalBytes
                ? "Checking integrity before saving."
                : "Receiving directly from the sender.",
            value: progress.transferredBytes,
            total: progress.totalBytes,
        });
    }

    setRtcDiagnostic(event: RtcDiagnosticEvent): void {
        const diagnostic = this.#diagnosticElement;
        const message = this.#diagnosticMessageElement;
        const totals = this.#diagnosticTotalsElement;
        if (
            diagnostic === undefined || message === undefined ||
            totals === undefined
        ) return;
        const presentation = presentRtcDiagnostic(event, "sender");
        diagnostic.hidden = false;
        diagnostic.toggleAttribute("data-error", presentation.isFailure);
        diagnostic.setAttribute(
            "role",
            presentation.isFailure ? "alert" : "status",
        );
        message.textContent = presentation.message;
        totals.textContent = presentation.totals ?? "";
    }

    #showActionError(error: unknown): void {
        if (this.#statusElement === undefined) return;
        this.#statusElement.textContent = error instanceof Error
            ? error.message
            : "Barrow Alley could not complete that action.";
        this.#statusElement.toggleAttribute("data-error", true);
        this.#statusElement.setAttribute("role", "alert");
    }
}

function receiverStatus(state: ReceiverState): string {
    switch (state) {
        case "idle":
            return "Looking for this pitch…";
        case "connecting":
            return "A sender was found. Requesting access…";
        case "awaiting-approval":
            return "Waiting for the sender to accept…";
        case "denied":
            return "The sender did not allow this connection.";
        case "loading-manifest":
            return "Access accepted. Loading the files…";
        case "browsing":
            return "Choose a file to receive.";
        case "receiving":
            return "Receiving and checking the selected file…";
        case "failed":
            return "This receive attempt stopped because of an error.";
        case "closing":
            return "Closing this receive attempt…";
        case "closed":
            return "This receive attempt is closed.";
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
