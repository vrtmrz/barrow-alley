import { describe, expect, it } from "vitest";

import { DEFAULT_RELAY_SETTINGS } from "../../src/transport/relay-settings.js";
import { ObsidianSettingsStore, type PluginDataAccess } from "../../src/obsidian/settings.js";

class MemoryPluginData implements PluginDataAccess {
    value: unknown;
    readonly saved: unknown[] = [];

    constructor(value: unknown) {
        this.value = value;
    }

    async loadData(): Promise<unknown> {
        return this.value;
    }

    async saveData(value: unknown): Promise<void> {
        this.saved.push(value);
        this.value = value;
    }
}

describe("Obsidian settings store", () => {
    it("loads a validated persisted list", async () => {
        const data = new MemoryPluginData({
            relays: [" wss://one.example ", "wss://two.example", "wss://one.example"],
        });
        const store = new ObsidianSettingsStore(data);

        await expect(store.load()).resolves.toEqual({
            relays: ["wss://one.example", "wss://two.example"],
            defaultReceiveFolderPath: null,
        });
    });

    it("uses defaults for absent, malformed, or invalid persisted data", async () => {
        for (const value of [null, {}, { relays: "wss://one.example" }, { relays: ["ws://bad"] }]) {
            const store = new ObsidianSettingsStore(new MemoryPluginData(value));
            await expect(store.load()).resolves.toEqual({
                ...DEFAULT_RELAY_SETTINGS,
                defaultReceiveFolderPath: null,
            });
        }
    });

    it("loads old relay-only data with no default receive folder", async () => {
        const store = new ObsidianSettingsStore(new MemoryPluginData({
            relays: ["wss://one.example"],
        }));

        await expect(store.load()).resolves.toEqual({
            relays: ["wss://one.example"],
            defaultReceiveFolderPath: null,
        });
    });

    it("validates and saves the complete effective list", async () => {
        const data = new MemoryPluginData(null);
        const store = new ObsidianSettingsStore(data);

        await expect(
            store.save({ relays: ["wss://one.example", "wss://two.example"] }),
        ).resolves.toEqual({
            relays: ["wss://one.example", "wss://two.example"],
            defaultReceiveFolderPath: null,
        });
        expect(data.saved).toEqual([
            {
                relays: ["wss://one.example", "wss://two.example"],
                defaultReceiveFolderPath: null,
            },
        ]);
    });

    it("preserves the default receive folder when relay settings are saved", async () => {
        const data = new MemoryPluginData({
            relays: ["wss://old.example"],
            defaultReceiveFolderPath: "incoming",
        });
        const store = new ObsidianSettingsStore(data);
        await store.load();

        await store.save({ relays: ["wss://new.example"] });

        expect(data.saved.at(-1)).toEqual({
            relays: ["wss://new.example"],
            defaultReceiveFolderPath: "incoming",
        });
    });

    it("preserves a persisted default even when a relay-only save follows no load", async () => {
        const data = new MemoryPluginData({
            relays: ["wss://old.example"],
            defaultReceiveFolderPath: "/",
        });
        const store = new ObsidianSettingsStore(data);

        await store.save({ relays: ["wss://new.example"] });

        expect(data.saved.at(-1)).toEqual({
            relays: ["wss://new.example"],
            defaultReceiveFolderPath: "/",
        });
    });

    it("keeps Vault-relative default paths and treats malformed paths as unset", async () => {
        for (const [value, expected] of [
            ["/", "/"],
            ["incoming", "incoming"],
            ["/incoming", null],
            ["incoming/", null],
            [42, null],
        ] as const) {
            const store = new ObsidianSettingsStore(new MemoryPluginData({
                relays: ["wss://one.example"],
                defaultReceiveFolderPath: value,
            }));

            await expect(store.load()).resolves.toMatchObject({
                defaultReceiveFolderPath: expected,
            });
        }
    });
});
