import { Notice, Plugin, type TFile, TFolder } from "obsidian";
import { confirmAction, pickOne, promptText } from "@vrtmrz/obsidian-plugin-kit/dialog";
import { showProgressNotice } from "@vrtmrz/obsidian-plugin-kit/progress";

import type { RelaySettings } from "../core/settings.js";
import type { IncomingFileMeta, Source } from "../core/files.js";
import { validatePitchNumber } from "../core/pitch-number.js";
import { TextSource } from "../core/text-source.js";
import { DEFAULT_RELAY_SETTINGS, parseRelayUrls } from "../transport/relay-settings.js";
import { createTrysteroTransport } from "../transport/trystero-transport.js";
import { registerSenderCommands } from "./sender-commands.js";
import { registerReceiverCommands } from "./receiver-commands.js";
import { ReceiverPitchController } from "./receiver-pitch-controller.js";
import { BarrowAlleyReceiverPitchModal } from "./receiver-pitch-modal.js";
import { promptPitchNumberWithKeypad } from "./pitch-number-modal.js";
import { SenderPitchController } from "./sender-pitch-controller.js";
import { BarrowAlleySenderPitchModal } from "./sender-pitch-modal.js";
import {
    DEFAULT_RECEIVE_FOLDER_PATH,
    normaliseReceiveFolderPath,
    ObsidianSettingsStore,
    type ObsidianSettings,
} from "./settings.js";
import { BarrowAlleySettingsTab } from "./settings-tab.js";
import { ObsidianVaultSource } from "./vault-source.js";
import { ObsidianVaultSink, VaultSinkError } from "./vault-sink.js";

type ReceiveMode = "default" | "folder";

interface ReceiveDestination {
    readonly path: string;
    readonly folder: TFolder;
}

/** Owns the Obsidian lifecycle for Barrow Alley. */
export class BarrowAlleyPlugin extends Plugin {
    #settings: ObsidianSettings = {
        relays: [...DEFAULT_RELAY_SETTINGS.relays],
        defaultReceiveFolderPath: DEFAULT_RECEIVE_FOLDER_PATH,
    };
    #settingsStore: ObsidianSettingsStore | undefined;
    #pitchController: SenderPitchController | undefined;
    #receiverController: ReceiverPitchController | undefined;
    #saveQueue: Promise<void> = Promise.resolve();

    override async onload(): Promise<void> {
        // Loading settings must not open a pitch or allocate network resources.
        this.#settingsStore = new ObsidianSettingsStore(this);
        this.#settings = await this.#settingsStore.load();
        this.#pitchController = new SenderPitchController({
            createTransport: async (options, rtcDiagnostics) =>
                createTrysteroTransport({
                    ...options,
                    rtcDiagnostics,
                }),
            createView: (model, actions) =>
                new BarrowAlleySenderPitchModal(this.app, model, actions),
        });
        this.#receiverController = new ReceiverPitchController({
            createTransport: async (options, rtcDiagnostics) =>
                createTrysteroTransport({
                    ...options,
                    rtcDiagnostics,
                }),
            createView: (model, actions) =>
                new BarrowAlleyReceiverPitchModal(this.app, model, actions),
        });
        registerSenderCommands(
            this,
            async (files) => this.#setUpFilesPitch(files),
            async (text) => this.#setUpTextPitch(text),
        );
        registerReceiverCommands(
            this,
            async () => this.#receiveFiles("default"),
            async () => this.#receiveFiles("folder"),
        );
        this.addSettingTab(new BarrowAlleySettingsTab(this));
    }

    override onunload(): void {
        // Obsidian does not await Component.onunload. shutdown() synchronously bars
        // new pitches, then its queued operation closes the UI and transport.
        void this.#pitchController?.shutdown().catch(() => undefined);
        void this.#receiverController?.shutdown().catch(() => undefined);
    }

    override async onExternalSettingsChange(): Promise<void> {
        if (this.#settingsStore === undefined) return;
        this.#settings = await this.#settingsStore.load();
    }

    /** Returns a copy so each newly created pitch owns an immutable relay snapshot. */
    getRelaySettingsSnapshot(): RelaySettings {
        return { relays: [...this.#settings.relays] };
    }

    /** Returns the configured default destination, or `null` when each receive asks. */
    getDefaultReceiveFolderPath(): string | null {
        return this.#settings.defaultReceiveFolderPath;
    }

    /** Returns Vault-relative paths for the settings destination selector. */
    getReceiveFolderPaths(): readonly string[] {
        return this.#listDestinationFolders().map((folder) => folder.path);
    }

    /** Validates, applies, and serialises one complete relay-list edit. */
    async setRelaySettingsText(input: string): Promise<void> {
        const store = this.#settingsStore;
        if (store === undefined) {
            throw new Error("Barrow Alley settings are not loaded.");
        }
        const snapshot: ObsidianSettings = {
            relays: parseRelayUrls(input),
            defaultReceiveFolderPath: this.#settings.defaultReceiveFolderPath,
        };
        this.#settings = snapshot;

        // Obsidian persistence calls are kept in edit order, even when change
        // handlers overlap while the user is typing.
        const saving = this.#saveQueue
            .catch(() => undefined)
            .then(async () => {
                await store.save(snapshot);
            });
        this.#saveQueue = saving;
        await saving;
    }

    /** Validates, applies, and serialises the configured default destination. */
    async setDefaultReceiveFolderPath(path: string | null): Promise<void> {
        const store = this.#settingsStore;
        if (store === undefined) {
            throw new Error("Barrow Alley settings are not loaded.");
        }
        const normalised = normaliseReceiveFolderPath(path);
        if (path !== null && path.trim().length > 0 && normalised === null) {
            throw new Error("The default receive folder must be Vault-relative.");
        }
        const snapshot: ObsidianSettings = {
            relays: [...this.#settings.relays],
            defaultReceiveFolderPath: normalised,
        };
        this.#settings = snapshot;
        const saving = this.#saveQueue
            .catch(() => undefined)
            .then(async () => {
                await store.save(snapshot);
            });
        this.#saveQueue = saving;
        await saving;
    }

    async #setUpFilesPitch(files: readonly TFile[]): Promise<void> {
        await this.#setUpPitch(
            () => new ObsidianVaultSource(this.app.vault, files),
            "Preparing files",
            "Reading and checking the selected files.",
        );
    }

    async #setUpTextPitch(text: string): Promise<void> {
        await this.#setUpPitch(
            () => new TextSource(text),
            "Preparing text",
            "Encoding and checking the entered text.",
        );
    }

    async #setUpPitch(
        createSource: () => Source,
        preparationTitle: string,
        preparationNote: string,
    ): Promise<void> {
        const controller = this.#pitchController;
        if (controller === undefined) {
            throw new Error("Barrow Alley is not loaded.");
        }
        if (controller.hasActivePitch) {
            const decision = await confirmAction(this.app, {
                title: "Replace the current pitch?",
                message: "The current visitor will be disconnected before the new pitch is set up.",
                actions: ["replace", "keep"],
                labels: {
                    replace: "Close and replace",
                    keep: "Keep current pitch",
                },
                defaultAction: "keep",
            });
            if (decision !== "replace") return;
        }

        const preparation = showProgressNotice({
            title: preparationTitle,
            note: preparationNote,
            total: 0,
            hideOnCompleteMs: 1500,
            hideOnCancelMs: 5000,
        });
        try {
            const source = createSource();
            await controller.setUpPitch(
                source,
                this.getRelaySettingsSnapshot(),
            );
            preparation.complete("Pitch ready.");
        } catch (error) {
            preparation.cancel(readableSetupError(error));
        }
    }

    async #receiveFiles(mode: ReceiveMode): Promise<void> {
        const controller = this.#receiverController;
        if (controller === undefined) {
            throw new Error("Barrow Alley is not loaded.");
        }

        let destination: ReceiveDestination | undefined;
        if (mode === "default" && this.#settings.defaultReceiveFolderPath !== null) {
            const path = this.#settings.defaultReceiveFolderPath;
            const folder = this.#resolveDestinationFolder(path);
            if (folder === null) {
                this.#noticeMissingDestination(path);
                return;
            }
            destination = { path, folder };
        }

        if (controller.hasActiveReceiver) {
            const decision = await confirmAction(this.app, {
                title: "Replace the current receive attempt?",
                message:
                    "The current sender will be disconnected before another Pitch number is used.",
                actions: ["replace", "keep"],
                labels: {
                    replace: "Close and replace",
                    keep: "Keep current attempt",
                },
                defaultAction: "keep",
            });
            if (decision !== "replace") return;
        }

        const pitchNumber = await this.#promptPitchNumber();
        if (pitchNumber === null) return;

        if (destination === undefined) {
            const folder = await this.#pickDestinationFolder();
            if (folder === null) return;
            destination = { path: folder.path, folder };
        }
        await this.#receivePitch(pitchNumber, destination, mode);
    }

    async #receivePitch(
        pitchNumber: string,
        destination: ReceiveDestination,
        mode: ReceiveMode,
    ): Promise<void> {
        const controller = this.#receiverController;
        if (controller === undefined) {
            throw new Error("Barrow Alley is not loaded.");
        }
        // Resolve again for retries and for a folder which disappeared between
        // selection and connection. Never turn a missing path into the Vault root.
        const folder = this.#resolveDestinationFolder(destination.path);
        if (folder === null) {
            this.#noticeMissingDestination(destination.path);
            return;
        }
        const sink = new ObsidianVaultSink(this.app.vault, folder);
        try {
            await controller.receivePitch(
                pitchNumber,
                {
                    sink,
                    prepare: async (meta) => this.#prepareDestination(sink, meta),
                },
                folder.path === "/" ? "Vault root" : folder.path,
                this.getRelaySettingsSnapshot(),
                async () => this.#retryReceive(mode, destination.path),
            );
        } catch (error) {
            new Notice(readableReceiveError(error));
        }
    }

    async #retryReceive(mode: ReceiveMode, destinationPath: string): Promise<void> {
        const folder = this.#resolveDestinationFolder(destinationPath);
        if (folder === null) {
            this.#noticeMissingDestination(destinationPath);
            return;
        }
        const pitchNumber = await this.#promptPitchNumber();
        if (pitchNumber === null) return;
        await this.#receivePitch(
            pitchNumber,
            { path: destinationPath, folder },
            mode,
        );
    }

    async #promptPitchNumber(): Promise<string | null> {
        const input = await promptPitchNumberWithKeypad(this.app);
        return input === null ? null : validatePitchNumber(input);
    }

    async #pickDestinationFolder(): Promise<TFolder | null> {
        const folders = this.#listDestinationFolders();
        return pickOne(this.app, {
            items: folders,
            getText: (folder) => folder.path === "/" ? "Vault root" : folder.path,
            placeholder: "Choose a destination folder",
        });
    }

    #listDestinationFolders(): TFolder[] {
        const root = this.app.vault.getRoot();
        return [
            root,
            ...this.app.vault
                .getAllLoadedFiles()
                .filter((entry): entry is TFolder => entry instanceof TFolder && entry !== root)
                .sort((left, right) => left.path.localeCompare(right.path)),
        ];
    }

    #resolveDestinationFolder(path: string): TFolder | null {
        if (path === "/") return this.app.vault.getRoot();
        if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
            return null;
        }
        return this.app.vault.getFolderByPath(path);
    }

    #noticeMissingDestination(path: string): void {
        const displayPath = path === "/" ? "Vault root" : path;
        new Notice(
            `The receive folder '${displayPath}' is no longer available. ` +
                "Choose another default in settings or use 'Receive files into a folder'. " +
                "No files were received.",
        );
    }

    async #prepareDestination(
        sink: ObsidianVaultSink<TFile, TFolder>,
        meta: IncomingFileMeta,
    ): Promise<boolean> {
        let fileName = meta.displayName;
        let overwrite = false;
        while (true) {
            try {
                sink.prepare(meta, { fileName, overwrite });
                return true;
            } catch (error) {
                if (!(error instanceof VaultSinkError)) throw error;
                if (error.code === "INVALID_FILE_NAME") {
                    new Notice(error.message);
                    const replacement = await this.#promptSaveAs(fileName);
                    if (replacement === null) return false;
                    fileName = replacement;
                    overwrite = false;
                    continue;
                }
                if (error.code === "DESTINATION_CHANGED" && overwrite) {
                    new Notice(error.message);
                    const replacement = await this.#promptSaveAs(fileName);
                    if (replacement === null) return false;
                    fileName = replacement;
                    overwrite = false;
                    continue;
                }
                if (error.code !== "DESTINATION_EXISTS") throw error;

                const decision = await confirmAction(this.app, {
                    title: "A file with this name already exists",
                    message: `Choose what to do with **${escapeMarkdown(fileName)}**.`,
                    actions: ["save-as", "overwrite", "skip", "cancel"],
                    labels: {
                        "save-as": "Save with another name",
                        overwrite: "Overwrite",
                        skip: "Skip",
                        cancel: "Cancel transfer",
                    },
                    defaultAction: "skip",
                    actionLayout: "vertical",
                });
                if (decision === "overwrite") {
                    overwrite = true;
                    continue;
                }
                if (decision === "save-as") {
                    const replacement = await this.#promptSaveAs(fileName);
                    if (replacement === null) return false;
                    fileName = replacement;
                    overwrite = false;
                    continue;
                }
                return false;
            }
        }
    }

    #promptSaveAs(initialValue: string): Promise<string | null> {
        return promptText(this.app, {
            title: "Save with another name",
            label: "File name",
            description: "The file will remain in the selected destination folder.",
            initialValue,
            submitLabel: "Use this name",
            cancelLabel: "Cancel transfer",
            selectInitialValue: true,
        });
    }
}

function readableSetupError(error: unknown): string {
    return error instanceof Error ? error.message : "Barrow Alley could not set up the pitch.";
}

function readableReceiveError(error: unknown): string {
    return error instanceof Error ? error.message : "Barrow Alley could not join the pitch.";
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}[\]()#+\-.!]/gu, "\\$&");
}
