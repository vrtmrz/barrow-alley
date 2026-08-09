import { describe, expect, it } from "vitest";

import { DEFAULT_RELAY_SETTINGS } from "../../src/transport/relay-settings.js";
import {
    LocalStorageRelaySettingsStore,
    type StorageLike,
} from "../web/src/relay-settings-store.js";

class MemoryStorage implements StorageLike {
    readonly #values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.#values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.#values.set(key, value);
    }
}

describe("browser relay settings store", () => {
    it("uses defaults when no browser setting exists", () => {
        const store = new LocalStorageRelaySettingsStore(new MemoryStorage());

        expect(store.load()).toEqual(DEFAULT_RELAY_SETTINGS);
    });

    it("round-trips a validated relay list", () => {
        const storage = new MemoryStorage();
        const store = new LocalStorageRelaySettingsStore(storage);

        store.saveText(" wss://one.example \n\nwss://two.example\nwss://one.example");

        expect(store.load()).toEqual({
            relays: ["wss://one.example", "wss://two.example"],
        });
        expect(store.loadText()).toBe("wss://one.example\nwss://two.example");
    });

    it("falls back safely when stored data is malformed or no longer valid", () => {
        const storage = new MemoryStorage();
        storage.setItem("barrow-alley.relay-urls", "not JSON");
        const store = new LocalStorageRelaySettingsStore(storage);

        expect(store.load()).toEqual(DEFAULT_RELAY_SETTINGS);

        storage.setItem("barrow-alley.relay-urls", JSON.stringify(["ws://relay.example"]));
        expect(store.load()).toEqual(DEFAULT_RELAY_SETTINGS);
    });
});
