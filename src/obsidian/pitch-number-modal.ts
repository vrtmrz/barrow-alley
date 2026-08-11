import { type App, Modal } from "obsidian";

import { PitchNumberKeypadModel } from "./pitch-number-keypad-model.js";

/** Opens number entry without focusing a text field or invoking a soft keyboard. */
export function promptPitchNumberWithKeypad(app: App): Promise<string | null> {
    return new Promise((resolve) => {
        new BarrowAlleyPitchNumberModal(app, resolve).open();
    });
}

/** Barrow Alley-owned, touch-friendly entry screen for an eight-digit number. */
class BarrowAlleyPitchNumberModal extends Modal {
    readonly #model = new PitchNumberKeypadModel();
    readonly #resolve: (pitchNumber: string | null) => void;
    #display: HTMLDivElement | undefined;
    #submit: HTMLButtonElement | undefined;
    #settled = false;

    constructor(app: App, resolve: (pitchNumber: string | null) => void) {
        super(app);
        this.#resolve = resolve;
    }

    override onOpen(): void {
        this.setTitle("Pitch number");
        const document = this.contentEl.ownerDocument;
        const root = document.createElement("div");
        root.className = "barrow-alley-number-entry";

        const instruction = document.createElement("p");
        instruction.textContent =
            "Ask the sender for the eight-digit number shown by Barrow Alley.";
        root.append(instruction);

        this.#display = document.createElement("div");
        this.#display.className = "barrow-alley-number-entry__display";
        this.#display.setAttribute("role", "status");
        this.#display.setAttribute("aria-live", "polite");
        this.#display.tabIndex = -1;
        root.append(this.#display);

        const keypad = document.createElement("div");
        keypad.className = "barrow-alley-number-entry__keypad";
        keypad.setAttribute("aria-label", "Pitch number keypad");
        for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
            keypad.append(this.#createDigitButton(document, digit));
        }

        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "Clear";
        clear.addEventListener("click", () => {
            this.#model.clear();
            this.#render();
        });
        keypad.append(clear, this.#createDigitButton(document, "0"));

        const deleteLast = document.createElement("button");
        deleteLast.type = "button";
        deleteLast.textContent = "Delete";
        deleteLast.setAttribute("aria-label", "Delete last digit");
        deleteLast.addEventListener("click", () => {
            this.#model.deleteLast();
            this.#render();
        });
        keypad.append(deleteLast);
        root.append(keypad);

        const footer = document.createElement("div");
        footer.className = "barrow-alley-number-entry__footer";
        this.#submit = document.createElement("button");
        this.#submit.type = "button";
        this.#submit.className = "mod-cta";
        this.#submit.textContent = "Request access";
        this.#submit.addEventListener("click", () => this.#submitNumber());
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.close());
        footer.append(this.#submit, cancel);
        root.append(footer);

        this.contentEl.replaceChildren(root);
        this.#registerPhysicalKeys();
        this.#render();
        this.#display.focus({ preventScroll: true });
    }

    override onClose(): void {
        this.#settle(null);
        this.contentEl.empty();
    }

    #createDigitButton(document: Document, digit: string): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "barrow-alley-number-entry__digit";
        button.textContent = digit;
        button.setAttribute("aria-label", `Enter ${digit}`);
        button.addEventListener("click", () => {
            this.#model.append(digit);
            this.#render();
        });
        return button;
    }

    #registerPhysicalKeys(): void {
        for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
            this.scope.register([], digit, (event) => {
                if (eventTargetIsButton(event)) return false;
                this.#model.append(digit);
                this.#render();
                return true;
            });
        }
        this.scope.register([], "Backspace", (event) => {
            if (eventTargetIsButton(event)) return false;
            this.#model.deleteLast();
            this.#render();
            return true;
        });
        this.scope.register([], "Enter", (event) => {
            if (eventTargetIsButton(event)) return false;
            this.#submitNumber();
            return true;
        });
    }

    #submitNumber(): void {
        const snapshot = this.#model.snapshot;
        if (!snapshot.complete) return;
        this.#settle(snapshot.value);
        this.close();
    }

    #render(): void {
        const snapshot = this.#model.snapshot;
        if (this.#display !== undefined) {
            this.#display.textContent = snapshot.display;
            this.#display.setAttribute(
                "aria-label",
                `${String(snapshot.value.length)} of 8 digits entered`,
            );
        }
        if (this.#submit !== undefined) {
            this.#submit.disabled = !snapshot.complete;
        }
    }

    #settle(pitchNumber: string | null): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#resolve(pitchNumber);
    }
}

function eventTargetIsButton(event: KeyboardEvent): boolean {
    return event.target instanceof Element && event.target.closest("button") !== null;
}
