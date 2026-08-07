import { Modal, type App } from "obsidian";
import { ProgressFragment } from "@vrtmrz/obsidian-plugin-kit/progress";

import type { SenderState, TransferProgress } from "../core/index.js";
import type {
  SenderPitchView,
  SenderPitchViewActions,
  SenderPitchViewModel,
} from "./sender-pitch-controller.js";

/** Persistent sender UI; its close event is the authoritative stop gesture. */
export class BarrowAlleySenderPitchModal extends Modal implements SenderPitchView {
  readonly #model: SenderPitchViewModel;
  readonly #actions: SenderPitchViewActions;
  #statusElement: HTMLParagraphElement | undefined;
  #approvalElement: HTMLDivElement | undefined;
  #acceptButton: HTMLButtonElement | undefined;
  #denyButton: HTMLButtonElement | undefined;
  #progress: ProgressFragment | undefined;

  constructor(app: App, model: SenderPitchViewModel, actions: SenderPitchViewActions) {
    super(app);
    this.#model = model;
    this.#actions = actions;
  }

  override onOpen(): void {
    this.setTitle("Barrow Alley");
    const document = this.contentEl.ownerDocument;
    const root = document.createElement("div");
    root.className = "barrow-alley-pitch";

    const summary = document.createElement("p");
    summary.className = "barrow-alley-pitch__summary";
    summary.textContent = `Pitch set up with ${formatFileCount(this.#model.files.length)}`;
    root.append(summary);

    const numberHeading = document.createElement("h3");
    numberHeading.textContent = "Pitch No.";
    root.append(numberHeading);

    const number = document.createElement("div");
    number.className = "barrow-alley-pitch__number";
    number.textContent = this.#model.pitchNumber;
    root.append(number);

    const files = document.createElement("details");
    const filesSummary = document.createElement("summary");
    filesSummary.textContent = `Files (${String(this.#model.files.length)})`;
    files.append(filesSummary);
    const fileList = document.createElement("ul");
    for (const file of this.#model.files) {
      const item = document.createElement("li");
      item.textContent = file;
      fileList.append(item);
    }
    files.append(fileList);
    root.append(files);

    this.#statusElement = document.createElement("p");
    this.#statusElement.className = "barrow-alley-pitch__status";
    this.#statusElement.textContent = "Preparing the pitch…";
    root.append(this.#statusElement);

    this.#approvalElement = this.#createApproval(document);
    this.#approvalElement.hidden = true;
    root.append(this.#approvalElement);

    this.#progress = new ProgressFragment({
      document,
      title: "Sending file",
      note: "Waiting for the visitor to choose a file.",
      collapsed: true,
      autoComplete: false,
      formatNumeric: ({ value, total }) =>
        total === 0 ? "" : `${formatBytes(value)} / ${formatBytes(total)}`,
    });
    root.append(this.#progress.fragment);

    const footer = document.createElement("div");
    footer.className = "barrow-alley-pitch__footer";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close the pitch";
    closeButton.addEventListener("click", () => this.close());
    footer.append(closeButton);
    root.append(footer);

    this.contentEl.replaceChildren(root);
  }

  override onClose(): void {
    this.contentEl.empty();
    // The UI is already gone, so cleanup failure has no presentation surface;
    // suppress an unhandled rejection during host-driven dismissal.
    void this.#actions.onClose().catch(() => undefined);
  }

  setState(state: SenderState): void {
    if (this.#statusElement === undefined || this.#approvalElement === undefined) return;
    this.#approvalElement.hidden = state !== "approval-pending";
    this.#statusElement.textContent = senderStatus(state);
    this.#statusElement.toggleAttribute("data-error", state === "failed");
    if (state !== "approval-pending") this.#setDecisionDisabled(false);
  }

  setProgress(progress: TransferProgress): void {
    const indicator = this.#progress;
    if (indicator === undefined) return;
    const fileName = fileNameForManifestId(progress.fileId, this.#model.files);
    indicator.update({
      collapsed: false,
      title: `Sending ${fileName}`,
      note:
        progress.transferredBytes === progress.totalBytes
          ? "Sent and verified by the sender."
          : "Sending directly to the visitor.",
      value: progress.transferredBytes,
      total: progress.totalBytes,
    });
  }

  #createApproval(document: Document): HTMLDivElement {
    const approval = document.createElement("div");
    approval.className = "barrow-alley-pitch__approval";
    const heading = document.createElement("h3");
    heading.textContent = "A visitor is requesting access.";
    approval.append(heading);
    const question = document.createElement("p");
    question.textContent = "Allow this visitor to view the files?";
    approval.append(question);
    const buttons = document.createElement("div");
    buttons.className = "barrow-alley-pitch__approval-buttons";
    this.#acceptButton = this.#createDecisionButton(document, "Accept", async () => {
      await this.#actions.onAccept();
    });
    this.#acceptButton.classList.add("mod-cta");
    this.#denyButton = this.#createDecisionButton(document, "Deny", async () => {
      await this.#actions.onDeny();
    });
    buttons.append(this.#acceptButton, this.#denyButton);
    approval.append(buttons);
    return approval;
  }

  #createDecisionButton(
    document: Document,
    label: string,
    action: () => Promise<void>,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      void this.#runDecision(action);
    });
    return button;
  }

  async #runDecision(action: () => Promise<void>): Promise<void> {
    this.#setDecisionDisabled(true);
    try {
      await action();
    } catch (error) {
      if (this.#statusElement !== undefined) {
        this.#statusElement.textContent = readableError(error);
        this.#statusElement.toggleAttribute("data-error", true);
      }
      this.#setDecisionDisabled(false);
    }
  }

  #setDecisionDisabled(disabled: boolean): void {
    if (this.#acceptButton !== undefined) this.#acceptButton.disabled = disabled;
    if (this.#denyButton !== undefined) this.#denyButton.disabled = disabled;
  }
}

function senderStatus(state: SenderState): string {
  switch (state) {
    case "idle":
    case "preparing":
      return "Preparing the pitch…";
    case "waiting-for-peer":
      return "Waiting for a visitor…";
    case "approval-pending":
      return "A visitor is waiting for your decision.";
    case "connected":
      return "Opening the pitch to the visitor…";
    case "serving":
      return "The visitor can choose from the files.";
    case "transferring":
      return "Sending a file directly to the visitor…";
    case "failed":
      return "The pitch stopped because of an error.";
    case "closing":
      return "Closing the pitch…";
    case "closed":
      return "The pitch is closed.";
  }
}

function formatFileCount(count: number): string {
  return count === 1 ? "1 file" : `${String(count)} files`;
}

function fileNameForManifestId(fileId: string, files: readonly string[]): string {
  const match = /^item-(\d+)$/u.exec(fileId);
  const index = match?.[1] === undefined ? Number.NaN : Number(match[1]) - 1;
  return files[index] ?? "file";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "Barrow Alley could not complete that action.";
}
