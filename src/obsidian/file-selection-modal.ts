import { type App, Modal, type TFile } from "obsidian";

/** Opens a Barrow Alley-owned multi-file picker for command-palette use. */
export function selectVaultFiles(
    app: App,
    files: readonly TFile[],
): Promise<readonly TFile[] | null> {
    return new Promise((resolve) => {
        new BarrowAlleyFileSelectionModal(app, files, resolve).open();
    });
}

class BarrowAlleyFileSelectionModal extends Modal {
    readonly #files: readonly TFile[];
    readonly #selected = new Set<TFile>();
    readonly #resolve: (files: readonly TFile[] | null) => void;
    #settled = false;
    #results: HTMLDivElement | undefined;
    #submit: HTMLButtonElement | undefined;

    constructor(
        app: App,
        files: readonly TFile[],
        resolve: (files: readonly TFile[] | null) => void,
    ) {
        super(app);
        this.#files = [...files].sort((left, right) => left.path.localeCompare(right.path));
        this.#resolve = resolve;
    }

    override onOpen(): void {
        this.setTitle("Select files for the pitch");
        const document = this.contentEl.ownerDocument;
        const search = document.createElement("input");
        search.className = "barrow-alley-file-picker__search";
        search.type = "search";
        search.placeholder = "Filter files";
        search.setAttribute("aria-label", "Filter files");
        search.addEventListener("input", () => this.#renderFiles(search.value));
        this.contentEl.append(search);

        this.#results = document.createElement("div");
        this.#results.className = "barrow-alley-file-picker__results";
        this.contentEl.append(this.#results);

        const footer = document.createElement("div");
        footer.className = "barrow-alley-file-picker__footer";
        this.#submit = document.createElement("button");
        this.#submit.type = "button";
        this.#submit.className = "mod-cta";
        this.#submit.textContent = "Set up a pitch";
        this.#submit.disabled = true;
        this.#submit.addEventListener("click", () => {
            this.#settle([...this.#selected]);
            this.close();
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.close());
        footer.append(this.#submit, cancel);
        this.contentEl.append(footer);
        this.#renderFiles("");
        search.focus();
    }

    override onClose(): void {
        this.#settle(null);
        this.contentEl.empty();
    }

    #renderFiles(query: string): void {
        const results = this.#results;
        if (results === undefined) return;
        const document = results.ownerDocument;
        const normalised = query.trim().toLocaleLowerCase();
        const matching = this.#files.filter((file) =>
            file.path.toLocaleLowerCase().includes(normalised)
        );
        const rows = matching.map((file) => {
            const label = document.createElement("label");
            label.className = "barrow-alley-file-picker__row";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.#selected.has(file);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) this.#selected.add(file);
                else this.#selected.delete(file);
                if (this.#submit !== undefined) this.#submit.disabled = this.#selected.size === 0;
            });
            const path = document.createElement("span");
            path.textContent = file.path;
            label.append(checkbox, path);
            return label;
        });
        if (rows.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = "No matching files.";
            results.replaceChildren(empty);
        } else {
            results.replaceChildren(...rows);
        }
    }

    #settle(files: readonly TFile[] | null): void {
        if (this.#settled) return;
        this.#settled = true;
        this.#resolve(files);
    }
}
