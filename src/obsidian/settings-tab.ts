import { PluginSettingTab, Setting } from "obsidian";

import {
    DEFAULT_RELAY_SETTINGS,
    RelaySettingsError,
    relayUrlsToText,
} from "../transport/relay-settings.js";
import type { BarrowAlleyPlugin } from "./plugin.js";

const RELAY_DESCRIPTION =
    "Enter one secure Nostr relay URL per line. The sender and visitor need at least one usable relay in common.";

/** Renders the persistent Barrow Alley settings supported by Obsidian 1.8.7. */
export class BarrowAlleySettingsTab extends PluginSettingTab {
    readonly #plugin: BarrowAlleyPlugin;

    constructor(plugin: BarrowAlleyPlugin) {
        super(plugin.app, plugin);
        this.#plugin = plugin;
    }

    override display(): void {
        const { containerEl } = this;
        containerEl.empty();

        let editRevision = 0;
        let relayEditor: HTMLTextAreaElement | undefined;
        const relaySetting = new Setting(containerEl)
            .setName("Nostr relays")
            .setDesc(RELAY_DESCRIPTION)
            .addTextArea((text) => {
                text
                    .setValue(relayUrlsToText(this.#plugin.getRelaySettingsSnapshot().relays))
                    .onChange(async (value) => {
                        const revision = ++editRevision;
                        try {
                            await this.#plugin.setRelaySettingsText(value);
                            if (revision === editRevision) {
                                showFeedback(
                                    "Relay settings saved. New pitches will use this list.",
                                    false,
                                );
                            }
                        } catch (error) {
                            if (revision === editRevision) {
                                showFeedback(toSettingsMessage(error), true);
                            }
                        }
                    });
                text.inputEl.rows = 6;
                text.inputEl.addClass("barrow-alley-relay-editor");
                relayEditor = text.inputEl;
            });
        const feedbackEl = relaySetting.controlEl.createDiv({
            cls: "barrow-alley-relay-feedback",
            attr: { "aria-live": "polite" },
        });

        const defaultReceiveFolderPath = this.#plugin.getDefaultReceiveFolderPath();
        const receiveFolderPaths = this.#plugin.getReceiveFolderPaths();
        new Setting(containerEl)
            .setName("Default receive folder")
            .setDesc(
                "Use this vault folder for received files, or select a folder for each receive.",
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("", "Ask every time");
                if (
                    defaultReceiveFolderPath !== null &&
                    !receiveFolderPaths.includes(defaultReceiveFolderPath)
                ) {
                    dropdown.addOption(
                        defaultReceiveFolderPath,
                        `${defaultReceiveFolderPath} (missing)`,
                    );
                }
                for (const path of receiveFolderPaths) {
                    dropdown.addOption(path, path === "/" ? "Vault root" : path);
                }
                dropdown.setValue(defaultReceiveFolderPath ?? "");
                dropdown.onChange(async (value) => {
                    try {
                        await this.#plugin.setDefaultReceiveFolderPath(value === "" ? null : value);
                        showFeedback(
                            "Default receive folder saved. New receive attempts will use this setting.",
                            false,
                        );
                    } catch (error) {
                        showFeedback(toDestinationSettingsMessage(error), true);
                    }
                });
            });

        new Setting(containerEl)
            .setName("Restore relay defaults")
            .setDesc("Replace the complete relay list with the defaults shipped by this version.")
            .addButton((button) => {
                button.setButtonText("Restore defaults").onClick(async () => {
                    const defaults = relayUrlsToText(DEFAULT_RELAY_SETTINGS.relays);
                    if (relayEditor !== undefined) relayEditor.value = defaults;
                    const revision = ++editRevision;
                    try {
                        await this.#plugin.setRelaySettingsText(defaults);
                        if (revision === editRevision) {
                            showFeedback(
                                "Relay defaults restored. New pitches will use this list.",
                                false,
                            );
                        }
                    } catch (error) {
                        if (revision === editRevision) showFeedback(toSettingsMessage(error), true);
                    }
                });
            });

        function showFeedback(message: string, isError: boolean): void {
            feedbackEl.setText(message);
            feedbackEl.toggleClass("mod-error", isError);
        }
    }
}

function toSettingsMessage(error: unknown): string {
    if (error instanceof RelaySettingsError) return error.message;
    return "Barrow Alley could not save the relay settings.";
}

function toDestinationSettingsMessage(error: unknown): string {
    return error instanceof Error
        ? error.message
        : "Barrow Alley could not save the default receive folder.";
}
