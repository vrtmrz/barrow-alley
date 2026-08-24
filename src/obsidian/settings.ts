import type { RelaySettings } from "../core/settings.js";
import { DEFAULT_RELAY_SETTINGS, parseRelayUrls } from "../transport/relay-settings.js";

/** Complete Obsidian settings persisted by Barrow Alley. */
export interface ObsidianSettings extends RelaySettings {
    /** Vault-relative destination path, or `null` to ask for each receive. */
    readonly defaultReceiveFolderPath: string | null;
}

/** The setting used by old data files which have no configured destination. */
export const DEFAULT_RECEIVE_FOLDER_PATH = null;

/** Injectable subset of Obsidian's plug-in persistence API. */
export interface PluginDataAccess {
    /** Reads the plug-in's untrusted persisted JSON-compatible value. */
    loadData(): Promise<unknown>;
    /** Replaces the plug-in's persisted JSON-compatible value. */
    saveData(data: unknown): Promise<void>;
}

/** Reads and writes the complete Barrow Alley settings object in `data.json`. */
export class ObsidianSettingsStore {
    readonly #data: PluginDataAccess;
    #settings: ObsidianSettings | undefined;

    constructor(data: PluginDataAccess) {
        this.#data = data;
    }

    async load(): Promise<ObsidianSettings> {
        const value = await this.#data.loadData();
        const settings = readSettings(value);
        this.#settings = settings;
        return copySettings(settings);
    }

    /**
     * Validates and saves the complete effective relay list.
     *
     * Relay-only callers are supported for compatibility, and retain the
     * currently loaded destination rather than deleting it from `data.json`.
     */
    async save(settings: RelaySettings | ObsidianSettings): Promise<ObsidianSettings> {
        const relays = parseRelayUrls(settings.relays.join("\n"));
        let defaultReceiveFolderPath: string | null;
        if ("defaultReceiveFolderPath" in settings) {
            defaultReceiveFolderPath = normaliseReceiveFolderPath(settings.defaultReceiveFolderPath);
        } else if (this.#settings !== undefined) {
            defaultReceiveFolderPath = this.#settings.defaultReceiveFolderPath;
        } else {
            const current = await this.#data.loadData();
            defaultReceiveFolderPath = isRecord(current)
                ? normaliseReceiveFolderPath(current.defaultReceiveFolderPath)
                : DEFAULT_RECEIVE_FOLDER_PATH;
        }
        const saved: ObsidianSettings = {
            relays: [...relays],
            defaultReceiveFolderPath,
        };
        await this.#data.saveData(saved);
        this.#settings = saved;
        return copySettings(saved);
    }
}

function readSettings(value: unknown): ObsidianSettings {
    if (!isRecord(value) || !Array.isArray(value.relays)) return copyDefaults();

    const relays = value.relays.every((relay) => typeof relay === "string")
        ? readRelays(value.relays)
        : [...DEFAULT_RELAY_SETTINGS.relays];
    return {
        relays,
        defaultReceiveFolderPath: normaliseReceiveFolderPath(value.defaultReceiveFolderPath),
    };
}

function readRelays(relays: readonly unknown[]): readonly string[] {
    try {
        return parseRelayUrls(relays.join("\n"));
    } catch {
        return [...DEFAULT_RELAY_SETTINGS.relays];
    }
}

function copyDefaults(): ObsidianSettings {
    return {
        relays: [...DEFAULT_RELAY_SETTINGS.relays],
        defaultReceiveFolderPath: DEFAULT_RECEIVE_FOLDER_PATH,
    };
}

function copySettings(settings: ObsidianSettings): ObsidianSettings {
    return {
        relays: [...settings.relays],
        defaultReceiveFolderPath: settings.defaultReceiveFolderPath,
    };
}

/**
 * Accepts only Vault-relative paths. Obsidian uses `/` for the Vault root;
 * `null` and an empty value both mean that the receiver should ask instead.
 */
export function normaliseReceiveFolderPath(value: unknown): string | null {
    if (value === null || value === undefined) return DEFAULT_RECEIVE_FOLDER_PATH;
    if (typeof value !== "string") return DEFAULT_RECEIVE_FOLDER_PATH;
    const path = value.trim();
    if (path.length === 0) return DEFAULT_RECEIVE_FOLDER_PATH;
    if (path === "/") return "/";
    if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
        return DEFAULT_RECEIVE_FOLDER_PATH;
    }
    return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
