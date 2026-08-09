import type { Plugin } from "obsidian";

export type ReceiveFilesHandler = () => void | Promise<void>;

/** Registers the Obsidian receiver entry point assigned to Milestone 5. */
export function registerReceiverCommands(
    plugin: Plugin,
    receiveFiles: ReceiveFilesHandler,
): void {
    plugin.addCommand({
        id: "receive-files",
        name: "Receive files",
        callback() {
            void receiveFiles();
        },
    });
}
