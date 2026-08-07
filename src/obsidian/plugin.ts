import { Plugin } from "obsidian";

import type { RelaySettings } from "../core/settings.js";
import {
  DEFAULT_RELAY_SETTINGS,
  parseRelayUrls,
} from "../transport/relay-settings.js";
import { ObsidianRelaySettingsStore } from "./settings.js";
import { BarrowAlleySettingsTab } from "./settings-tab.js";

/** Owns the Obsidian lifecycle for Barrow Alley. */
export class BarrowAlleyPlugin extends Plugin {
  #settings: RelaySettings = { relays: [...DEFAULT_RELAY_SETTINGS.relays] };
  #settingsStore: ObsidianRelaySettingsStore | undefined;
  #saveQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    // Loading settings must not open a pitch or allocate network resources.
    this.#settingsStore = new ObsidianRelaySettingsStore(this);
    this.#settings = await this.#settingsStore.load();
    this.addSettingTab(new BarrowAlleySettingsTab(this));
  }

  override async onExternalSettingsChange(): Promise<void> {
    if (this.#settingsStore === undefined) return;
    this.#settings = await this.#settingsStore.load();
  }

  /** Returns a copy so each newly created pitch owns an immutable relay snapshot. */
  getRelaySettingsSnapshot(): RelaySettings {
    return { relays: [...this.#settings.relays] };
  }

  /** Validates, applies, and serialises one complete relay-list edit. */
  async setRelaySettingsText(input: string): Promise<void> {
    const store = this.#settingsStore;
    if (store === undefined) throw new Error("Barrow Alley settings are not loaded.");
    const snapshot: RelaySettings = { relays: parseRelayUrls(input) };
    this.#settings = { relays: [...snapshot.relays] };

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
}
