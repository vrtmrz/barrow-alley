<script lang="ts">
import {
    DEFAULT_RELAY_SETTINGS,
    RelaySettingsError,
    relayUrlsToText,
} from "../../../src/transport/relay-settings.js";
import { LocalStorageRelaySettingsStore } from "./relay-settings-store.js";

const relayStore = new LocalStorageRelaySettingsStore(window.localStorage);
let relayText = $state(relayStore.loadText());
let relayFeedback = $state("");
let relayFeedbackIsError = $state(false);

function saveRelaySettings(): void {
    try {
        relayStore.saveText(relayText);
        relayFeedback = "Relay settings saved. New pitches will use this list.";
        relayFeedbackIsError = false;
    } catch (error) {
        relayFeedback = error instanceof RelaySettingsError
            ? error.message
            : "Barrow Alley could not save the relay settings.";
        relayFeedbackIsError = true;
    }
}

function restoreRelayDefaults(): void {
    relayText = relayUrlsToText(DEFAULT_RELAY_SETTINGS.relays);
    saveRelaySettings();
}
</script>

<svelte:head>
    <title>Barrow Alley interoperability harness</title>
</svelte:head>

<main>
    <section aria-labelledby="barrow-alley-title">
        <p class="eyebrow">Browser interoperability harness</p>
        <h1 id="barrow-alley-title">Barrow Alley</h1>
        <p class="tagline">Set up a pitch. Share the number. Let them choose.</p>
        <div class="settings" aria-labelledby="relay-settings-title">
      <h2 id="relay-settings-title">Nostr relays</h2>
      <p>Enter one secure relay URL per line.</p>
      <p>The sender and visitor need at least one usable relay in common.</p>
      <label for="relay-urls">Relay URLs</label>
      <textarea id="relay-urls" bind:value={relayText} rows="6"></textarea>
      <div class="settings-actions">
        <button type="button" onclick={saveRelaySettings}>Save relays</button>
        <button type="button" class="secondary" onclick={restoreRelayDefaults}>
          Restore defaults
        </button>
      </div>
      {#if relayFeedback.length > 0}
        <p class:error={relayFeedbackIsError} class="feedback" aria-live="polite">
          {relayFeedback}
        </p>
      {/if}
    </div>
    </section>
</main>
