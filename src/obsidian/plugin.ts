import { Plugin, type TFile } from "obsidian";
import { confirmAction } from "@vrtmrz/obsidian-plugin-kit/dialog";
import { showProgressNotice } from "@vrtmrz/obsidian-plugin-kit/progress";

import type { RelaySettings } from "../core/settings.js";
import {
  DEFAULT_RELAY_SETTINGS,
  parseRelayUrls,
} from "../transport/relay-settings.js";
import { createTrysteroTransport } from "../transport/trystero-transport.js";
import { registerSenderCommands } from "./sender-commands.js";
import { SenderPitchController } from "./sender-pitch-controller.js";
import { BarrowAlleySenderPitchModal } from "./sender-pitch-modal.js";
import { ObsidianRelaySettingsStore } from "./settings.js";
import { BarrowAlleySettingsTab } from "./settings-tab.js";
import { ObsidianVaultSource } from "./vault-source.js";

/** Owns the Obsidian lifecycle for Barrow Alley. */
export class BarrowAlleyPlugin extends Plugin {
  #settings: RelaySettings = { relays: [...DEFAULT_RELAY_SETTINGS.relays] };
  #settingsStore: ObsidianRelaySettingsStore | undefined;
  #pitchController: SenderPitchController | undefined;
  #saveQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    // Loading settings must not open a pitch or allocate network resources.
    this.#settingsStore = new ObsidianRelaySettingsStore(this);
    this.#settings = await this.#settingsStore.load();
    this.#pitchController = new SenderPitchController({
      createTransport: async (options, rtcDiagnostics) =>
        createTrysteroTransport({
          ...options,
          rtcDiagnostics,
        }),
      createView: (model, actions) =>
        new BarrowAlleySenderPitchModal(this.app, model, actions),
    });
    registerSenderCommands(this, async (files) => this.#setUpPitch(files));
    this.addSettingTab(new BarrowAlleySettingsTab(this));
  }

  override onunload(): void {
    // Obsidian does not await Component.onunload. shutdown() synchronously bars
    // new pitches, then its queued operation closes the UI and transport.
    void this.#pitchController?.shutdown().catch(() => undefined);
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

  async #setUpPitch(files: readonly TFile[]): Promise<void> {
    const controller = this.#pitchController;
    if (controller === undefined) throw new Error("Barrow Alley is not loaded.");
    if (controller.hasActivePitch) {
      const decision = await confirmAction(this.app, {
        title: "Replace the current pitch?",
        message: "The current visitor will be disconnected before the new pitch is set up.",
        actions: ["replace", "keep"],
        labels: {
          replace: "Close and replace",
          keep: "Keep current pitch",
        },
        defaultAction: "keep",
      });
      if (decision !== "replace") return;
    }

    const preparation = showProgressNotice({
      title: "Preparing files",
      note: "Reading and checking the selected files.",
      total: 0,
      hideOnCompleteMs: 1500,
      hideOnCancelMs: 5000,
    });
    try {
      const source = new ObsidianVaultSource(this.app.vault, files);
      await controller.setUpPitch(source, this.getRelaySettingsSnapshot());
      preparation.complete("Pitch ready.");
    } catch (error) {
      preparation.cancel(readableSetupError(error));
    }
  }
}

function readableSetupError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Barrow Alley could not set up the pitch.";
}
