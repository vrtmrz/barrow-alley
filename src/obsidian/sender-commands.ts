import { type Plugin, TFile } from "obsidian";

import { selectVaultFiles } from "./file-selection-modal.js";
import { promptTextForPitch } from "./text-input-modal.js";

export type SetUpPitchHandler = (files: readonly TFile[]) => void | Promise<void>;
export type SetUpTextPitchHandler = (text: string) => void | Promise<void>;

/** Registers only the Obsidian sender entry points assigned to Milestone 4. */
export function registerSenderCommands(
    plugin: Plugin,
    setUpPitch: SetUpPitchHandler,
    setUpTextPitch: SetUpTextPitchHandler,
): void {
    plugin.addCommand({
        id: "set-up-pitch-current-file",
        name: "Set up a pitch for current file",
        checkCallback(checking) {
            const file = plugin.app.workspace.getActiveFile();
            if (file === null) return false;
            if (!checking) void setUpPitch([file]);
            return true;
        },
    });

    plugin.addCommand({
        id: "set-up-pitch-selected-files",
        name: "Set up a pitch for selected files",
        checkCallback(checking) {
            const files = plugin.app.vault.getFiles();
            if (files.length === 0) return false;
            if (!checking) {
                void selectVaultFiles(plugin.app, files).then(async (selected) => {
                    if (selected !== null && selected.length > 0) await setUpPitch(selected);
                });
            }
            return true;
        },
    });

    plugin.addCommand({
        id: "set-up-pitch-text",
        name: "Set up a pitch for text",
        callback: async () => {
            const text = await promptTextForPitch(plugin.app);
            if (text !== null) await setUpTextPitch(text);
        },
    });

    plugin.registerEvent(
        plugin.app.workspace.on("file-menu", (menu, target) => {
            if (!(target instanceof TFile)) return;
            menu.addItem((item) => {
                item
                    .setTitle("Set up a pitch for this file")
                    .setIcon("send")
                    .onClick(() => setUpPitch([target]));
            });
        }),
    );

    plugin.registerEvent(
        plugin.app.workspace.on("files-menu", (menu, targets) => {
            const files = targets.filter((target): target is TFile => target instanceof TFile);
            if (files.length === 0) return;
            menu.addItem((item) => {
                item
                    .setTitle("Set up a pitch for selected files")
                    .setIcon("send")
                    .onClick(() => setUpPitch(files));
            });
        }),
    );
}
