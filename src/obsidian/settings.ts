import type { RelaySettings } from "../core/settings.js";
import { DEFAULT_RELAY_SETTINGS, parseRelayUrls } from "../transport/relay-settings.js";

/** Injectable subset of Obsidian's plug-in persistence API. */
export interface PluginDataAccess {
    /** Reads the plug-in's untrusted persisted JSON-compatible value. */
    loadData(): Promise<unknown>;
    /** Replaces the plug-in's persisted JSON-compatible value. */
    saveData(data: unknown): Promise<void>;
}

/** Reads and writes the complete effective relay list in `data.json`. */
export class ObsidianRelaySettingsStore {
    readonly #data: PluginDataAccess;

    constructor(data: PluginDataAccess) {
        this.#data = data;
    }

    async load(): Promise<RelaySettings> {
        const value = await this.#data.loadData();
        if (!isRecord(value) || !Array.isArray(value.relays)) return copyDefaults();
        if (!value.relays.every((relay) => typeof relay === "string")) return copyDefaults();

        try {
            return { relays: parseRelayUrls(value.relays.join("\n")) };
        } catch {
            return copyDefaults();
        }
    }

    async save(settings: RelaySettings): Promise<RelaySettings> {
        const relays = parseRelayUrls(settings.relays.join("\n"));
        const saved = { relays: [...relays] };
        await this.#data.saveData(saved);
        return saved;
    }
}

function copyDefaults(): RelaySettings {
    return { relays: [...DEFAULT_RELAY_SETTINGS.relays] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
