import { describe, expect, it } from "vitest";
import type { Command, Plugin } from "obsidian";

import { registerReceiverCommands } from "../../src/obsidian/receiver-commands.js";

describe("receiver commands", () => {
    it("keeps the default receive command and adds an explicit folder picker", async () => {
        const commands: Command[] = [];
        const calls: string[] = [];
        const plugin = {
            addCommand(command: Command): void {
                commands.push(command);
            },
        } as unknown as Plugin;

        registerReceiverCommands(
            plugin,
            () => {
                calls.push("default");
            },
            () => {
                calls.push("folder");
            },
        );

        expect(commands.map((command) => command.id)).toEqual([
            "receive-files",
            "receive-files-into-folder",
        ]);
        expect(commands.map((command) => command.name)).toEqual([
            "Receive files",
            "Receive files into a folder",
        ]);
        await commands[0]?.callback?.();
        await commands[1]?.callback?.();
        expect(calls).toEqual(["default", "folder"]);
    });
});
