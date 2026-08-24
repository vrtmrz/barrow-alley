import { type App, Modal } from "obsidian";

/** Opens the owned multiline editor used to prepare one text-file pitch. */
export function promptTextForPitch(app: App): Promise<string | null> {
    return new Promise((resolve) => {
        new BarrowAlleyTextInputModal(app, resolve).open();
    });
}

/** Collects an exact text snapshot without reading from the system clipboard. */
class BarrowAlleyTextInputModal extends Modal {
    readonly #resolve: (text: string | null) => void;
    #settled = false;

    constructor(app: App, resolve: (text: string | null) => void) {
        super(app);
        this.#resolve = resolve;
    }

    override onOpen(): void {
        this.setTitle("Set up a pitch for text");
        const document = this.contentEl.ownerDocument;
        const root = document.createElement("div");
        root.className = "barrow-alley-text-entry";

        const description = document.createElement("p");
        description.textContent =
            "Enter or paste text. The visitor will receive it as a timestamped .txt file.";

        const input = document.createElement("textarea");
        input.className = "barrow-alley-text-entry__input";
        input.rows = 10;
        input.placeholder = [
            "Paste text to share, for example:",
            "foo_bar_token: pat_deafbeef",
        ].join("\n");
        input.setAttribute("aria-label", "Text to share");

        const footer = document.createElement("div");
        footer.className = "barrow-alley-text-entry__footer";
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "mod-cta";
        submit.textContent = "Set up a pitch";
        submit.disabled = true;
        const submitText = (): void => {
            if (input.value.length === 0) return;
            this.#settle(input.value);
            this.close();
        };
        submit.addEventListener("click", submitText);
        input.addEventListener("input", () => {
            submit.disabled = input.value.length === 0;
        });
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
            event.preventDefault();
            submitText();
        });

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.close());
        footer.append(submit, cancel);
        root.append(description, input, footer);
        this.contentEl.replaceChildren(root);
        input.focus();
    }

    override onClose(): void {
        this.#settle(null);
        this.contentEl.empty();
    }

    #settle(text: string | null): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#resolve(text);
    }
}
