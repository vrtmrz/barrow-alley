import { describe, expect, it } from "vitest";

import { DEFAULT_RELAY_SETTINGS } from "../../src/transport/relay-settings.js";
import { ObsidianRelaySettingsStore, type PluginDataAccess } from "../../src/obsidian/settings.js";

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

describe("Obsidian relay settings store", () => {
    it("loads a validated persisted list", async () => {
        const data = new MemoryPluginData({
            relays: [" wss://one.example ", "wss://two.example", "wss://one.example"],
        });
        const store = new ObsidianRelaySettingsStore(data);

        await expect(store.load()).resolves.toEqual({
            relays: ["wss://one.example", "wss://two.example"],
        });
    });

    it("uses defaults for absent, malformed, or invalid persisted data", async () => {
        for (const value of [null, {}, { relays: "wss://one.example" }, { relays: ["ws://bad"] }]) {
            const store = new ObsidianRelaySettingsStore(new MemoryPluginData(value));
            await expect(store.load()).resolves.toEqual(DEFAULT_RELAY_SETTINGS);
        }
    });

    it("validates and saves the complete effective list", async () => {
        const data = new MemoryPluginData(null);
        const store = new ObsidianRelaySettingsStore(data);

        await expect(
            store.save({ relays: ["wss://one.example", "wss://two.example"] }),
        ).resolves.toEqual({ relays: ["wss://one.example", "wss://two.example"] });
        expect(data.saved).toEqual([
            { relays: ["wss://one.example", "wss://two.example"] },
        ]);
    });
});
