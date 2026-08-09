import type { RelaySettings } from "../../../src/core/settings.js";
import {
    DEFAULT_RELAY_SETTINGS,
    parseRelayUrls,
    relayUrlsToText,
} from "../../../src/transport/relay-settings.js";

const RELAY_STORAGE_KEY = "barrow-alley.relay-urls";

/** Small injectable subset of the browser Storage contract. */
export interface StorageLike {
    /** Reads one serialised browser setting or `null` when it is absent. */
    getItem(key: string): string | null;
    /** Replaces one serialised browser setting. */
    setItem(key: string, value: string): void;
}

/** Persists the browser harness's complete effective relay list. */
export class LocalStorageRelaySettingsStore {
    readonly #storage: StorageLike;

    constructor(storage: StorageLike) {
        this.#storage = storage;
    }

    load(): RelaySettings {
        const stored = this.#storage.getItem(RELAY_STORAGE_KEY);
        if (stored === null) return copyDefaults();

        try {
            const value: unknown = JSON.parse(stored);
            if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
                return copyDefaults();
            }
            return { relays: parseRelayUrls(value.join("\n")) };
        } catch {
            return copyDefaults();
        }
    }

    loadText(): string {
        return relayUrlsToText(this.load().relays);
    }

    saveText(input: string): RelaySettings {
        const relays = parseRelayUrls(input);
        this.#storage.setItem(RELAY_STORAGE_KEY, JSON.stringify(relays));
        return { relays: [...relays] };
    }
}

function copyDefaults(): RelaySettings {
    return { relays: [...DEFAULT_RELAY_SETTINGS.relays] };
}
