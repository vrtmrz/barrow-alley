<script lang="ts">
import { onMount } from "svelte";

import type { TransferProgress } from "../../../src/core/transfer/progress.js";
import {
    DEFAULT_RELAY_SETTINGS,
    RelaySettingsError,
    relayUrlsToText,
} from "../../../src/transport/relay-settings.js";
import { createTrysteroTransport } from "../../../src/transport/trystero-transport.js";
import { BrowserDownloadSink, DomBrowserDownloadTarget } from "./browser-download-sink.js";
import { BrowserFileSource } from "./browser-file-source.js";
import {
    BrowserPitchController,
    BrowserPitchControllerError,
    type BrowserPitchSnapshot,
} from "./browser-pitch-controller.js";
import {
    browserErrorMessage,
    formatBytes,
    peerErrorMessage,
    receiverStatus,
    rtcStatus,
    senderStatus,
} from "./presentation.js";
import { LocalStorageRelaySettingsStore } from "./relay-settings-store.js";

const relayStore = new LocalStorageRelaySettingsStore(window.localStorage);
const downloadTarget = new DomBrowserDownloadTarget(
    document,
    URL,
    (callback) => window.setTimeout(callback, 0),
);
const downloadSink = new BrowserDownloadSink(downloadTarget);

let snapshot: BrowserPitchSnapshot = $state({ mode: "idle" });
let selectedFiles: File[] = $state([]);
let pitchInput = $state("");
let relayText = $state(relayStore.loadText());
let relayFeedback = $state("");
let relayFeedbackIsError = $state(false);
let actionError = $state("");
let starting = $state(false);
let acting = $state(false);
let draggingFiles = $state(false);

const controller = new BrowserPitchController({
    createTransport: async (options, onRtcDiagnostic) =>
        createTrysteroTransport({
            ...options,
            rtcDiagnostics: onRtcDiagnostic,
        }),
    onChange: (nextSnapshot) => {
        snapshot = nextSnapshot;
    },
});

onMount(() => {
    const handlePageHide = (event: PageTransitionEvent): void => {
        // A page kept in the back-forward cache may become interactive again. Close
        // its active session without making the reusable controller terminal.
        if (event.persisted) void controller.closeActive().catch(() => undefined);
        else void controller.shutdown().catch(() => undefined);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
        window.removeEventListener("pagehide", handlePageHide);
        void controller.shutdown().catch(() => undefined);
    };
});

function selectFiles(files: FileList | null): void {
    if (files === null) return;
    selectedFiles = Array.from(files);
    actionError = "";
}

function handleDrop(event: DragEvent): void {
    event.preventDefault();
    draggingFiles = false;
    selectFiles(event.dataTransfer?.files ?? null);
}

async function setUpPitch(): Promise<void> {
    actionError = "";
    starting = true;
    try {
        const source = new BrowserFileSource(selectedFiles);
        await controller.setUpPitch(source, relayStore.load());
    } catch (error) {
        reportActionError(error);
    } finally {
        starting = false;
    }
}

async function receiveFiles(): Promise<void> {
    actionError = "";
    starting = true;
    try {
        await controller.receivePitch(pitchInput, downloadSink, relayStore.load());
    } catch (error) {
        reportActionError(error);
    } finally {
        starting = false;
    }
}

async function acceptVisitor(): Promise<void> {
    await runAction(() => controller.accept());
}

async function denyVisitor(): Promise<void> {
    await runAction(() => controller.deny());
}

async function downloadFile(fileId: string): Promise<void> {
    await runAction(() => controller.requestFile(fileId));
}

async function cancelDownload(): Promise<void> {
    await runAction(() => controller.cancelFile());
}

async function closeActive(): Promise<void> {
    await runAction(() => controller.closeActive());
}

async function runAction(action: () => Promise<void>): Promise<void> {
    actionError = "";
    acting = true;
    try {
        await action();
    } catch (error) {
        reportActionError(error);
    } finally {
        acting = false;
    }
}

function reportActionError(error: unknown): void {
    if (error instanceof BrowserPitchControllerError && error.code === "CANCELLED") return;
    actionError = browserErrorMessage(error);
}

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

function transferPercent(progress: TransferProgress): number {
    if (progress.totalBytes === 0) return 100;
    return Math.min(100, Math.round(progress.transferredBytes / progress.totalBytes * 100));
}

function transferSummary(progress: TransferProgress): string {
    return `${formatBytes(progress.transferredBytes)} of ${formatBytes(progress.totalBytes)}`;
}
</script>

<svelte:head>
    <title>Barrow Alley</title>
    <meta
        name="description"
        content="Set up a temporary peer-to-peer pitch and let one accepted visitor choose files."
    />
</svelte:head>

<main>
    <header class="masthead" aria-labelledby="barrow-alley-title">
        <p class="eyebrow">Temporary peer-to-peer file handoff</p>
        <h1 id="barrow-alley-title">Barrow Alley</h1>
        <p class="tagline">Set up a pitch. Share the number. Let them choose.</p>
    </header>

    {#if actionError.length > 0}
        <aside class="notice error-notice" role="alert">
            <strong>That did not work.</strong>
            <span>{actionError}</span>
        </aside>
    {/if}

    {#if snapshot.mode === "idle"}
        <div class="role-grid">
            <section class="panel" aria-labelledby="send-title">
                <div class="panel-heading">
                    <span class="step">1</span>
                    <div>
                        <h2 id="send-title">Set up a pitch</h2>
                        <p>Select files, then share the temporary number.</p>
                    </div>
                </div>

                <label
                    class:dragging={draggingFiles}
                    class="drop-zone"
                    ondragenter={(event) => {
                        event.preventDefault();
                        draggingFiles = true;
                    }}
                    ondragover={(event) => event.preventDefault()}
                    ondragleave={() => draggingFiles = false}
                    ondrop={handleDrop}
                >
                    <input
                        type="file"
                        multiple
                        aria-label="Choose files to set up a pitch"
                        onchange={(event) => selectFiles(event.currentTarget.files)}
                    />
                    <span class="drop-title">Drop files here</span>
                    <span>or choose files from this device</span>
                </label>

                {#if selectedFiles.length > 0}
                    <div class="selected-files">
                        <h3>Selected files</h3>
                        <ul class="file-list compact">
                            {#each selectedFiles as file, index (`${file.name}:${file.lastModified}:${index}`)}
                                <li>
                                    <span>{file.name}</span>
                                    <span class="file-size">{formatBytes(file.size)}</span>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}

                <button
                    class="primary full-width"
                    type="button"
                    disabled={selectedFiles.length === 0 || starting}
                    onclick={setUpPitch}
                >
                    {starting ? "Preparing files…" : "Set up a pitch"}
                </button>
            </section>

            <section class="panel" aria-labelledby="receive-title">
                <div class="panel-heading">
                    <span class="step">2</span>
                    <div>
                        <h2 id="receive-title">Receive files</h2>
                        <p>Enter the sender's eight-digit Pitch number.</p>
                    </div>
                </div>

                <label class="field-label" for="pitch-number">Pitch number</label>
                <input
                    id="pitch-number"
                    class="pitch-input"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="9"
                    placeholder="1234 5678"
                    bind:value={pitchInput}
                />
                <p class="field-help">
                    The sender must accept you before the file list is shared.
                </p>
                <button
                    class="primary full-width"
                    type="button"
                    disabled={pitchInput.trim().length === 0 || starting}
                    onclick={receiveFiles}
                >
                    {starting ? "Finding the pitch…" : "Visit the pitch"}
                </button>
            </section>
        </div>
        {#if starting}
            <div class="cancel-start">
                <button class="text-button" type="button" onclick={closeActive}>
                    Cancel connection attempt
                </button>
            </div>
        {/if}
    {:else if snapshot.mode === "sender"}
        <section class="session-panel sender-session" aria-labelledby="pitch-heading">
            <div class="session-header">
                <div>
                    <p class="eyebrow">Pitch set up with {snapshot.files.length} files</p>
                    <h2 id="pitch-heading">Pitch No.</h2>
                </div>
                <button class="secondary" type="button" disabled={acting} onclick={closeActive}>
                    Close the pitch
                </button>
            </div>
            <p class="pitch-number" aria-label={`Pitch number ${snapshot.pitchNumber}`}>
                {snapshot.pitchNumber}
            </p>
            <p class="status-line" aria-live="polite">{senderStatus(snapshot.state)}</p>

            {#if snapshot.state === "approval-pending"}
                <div class="approval-box">
                    <div>
                        <h3>Connection request</h3>
                        <p>Accept to share the file list with this visitor, or deny the request.</p>
                    </div>
                    <div class="button-row">
                        <button class="primary" type="button" disabled={acting} onclick={acceptVisitor}>
                            Accept
                        </button>
                        <button class="danger" type="button" disabled={acting} onclick={denyVisitor}>
                            Deny
                        </button>
                    </div>
                </div>
            {/if}

            <div class="session-grid">
                <div>
                    <h3>Files</h3>
                    <ul class="file-list">
                        {#each snapshot.files as file}
                            <li>
                                <span>{file.displayName}</span>
                                <span class="file-size">{formatBytes(file.size)}</span>
                            </li>
                        {/each}
                    </ul>
                </div>
                <div class="status-stack">
                    {#if snapshot.progress !== undefined}
                        <div class="progress-card">
                            <h3>Transfer</h3>
                            <progress
                                max="100"
                                value={transferPercent(snapshot.progress)}
                            ></progress>
                            <p>{transferSummary(snapshot.progress)}</p>
                            <p class="quiet">
                                {snapshot.progress.transferredBytes === snapshot.progress.totalBytes
                                    ? "File sent."
                                    : "Sending directly to the accepted visitor."}
                            </p>
                        </div>
                    {/if}
                    {#if snapshot.rtcDiagnostic !== undefined}
                        {@const diagnostic = rtcStatus(snapshot.rtcDiagnostic, "sender")}
                        <div class:failure={diagnostic.isFailure} class="diagnostic-card">
                            <h3>Direct connection</h3>
                            <p>{diagnostic.message}</p>
                            {#if diagnostic.totals !== undefined}
                                <p class="diagnostic-totals">{diagnostic.totals}</p>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        </section>
    {:else}
        <section class="session-panel receiver-session" aria-labelledby="visit-heading">
            <div class="session-header">
                <div>
                    <p class="eyebrow">Visiting a pitch</p>
                    <h2 id="visit-heading">Pitch No. {snapshot.pitchNumber}</h2>
                </div>
                <button class="secondary" type="button" disabled={acting} onclick={closeActive}>
                    Leave the pitch
                </button>
            </div>
            <p class="status-line" aria-live="polite">{receiverStatus(snapshot.state)}</p>

            {#if snapshot.peerError !== undefined}
                <div class="notice error-notice" role="alert">
                    {peerErrorMessage(snapshot.peerError)}
                </div>
            {/if}

            <div class="session-grid">
                <div>
                    <h3>Available files</h3>
                    {#if snapshot.manifest.length === 0}
                        <p class="empty-list">The file list is not available yet.</p>
                    {:else}
                        <ul class="file-list download-list">
                            {#each snapshot.manifest as file}
                                <li>
                                    <div>
                                        <span>{file.displayName}</span>
                                        <span class="file-size">{formatBytes(file.size)}</span>
                                    </div>
                                    <button
                                        class="small-button"
                                        type="button"
                                        disabled={acting || snapshot.state !== "browsing"}
                                        onclick={() => downloadFile(file.id)}
                                    >
                                        Download
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
                <div class="status-stack">
                    {#if snapshot.progress !== undefined}
                        <div class="progress-card">
                            <h3>Download</h3>
                            <progress
                                max="100"
                                value={transferPercent(snapshot.progress)}
                            ></progress>
                            <p>{transferSummary(snapshot.progress)}</p>
                            {#if snapshot.state === "receiving"}
                                <p class="quiet">
                                    {snapshot.progress.transferredBytes === snapshot.progress.totalBytes
                                        ? "Checking integrity before download…"
                                        : "No download starts until integrity is verified."}
                                </p>
                                <button
                                    class="text-button"
                                    type="button"
                                    disabled={acting}
                                    onclick={cancelDownload}
                                >
                                    Cancel download
                                </button>
                            {:else if snapshot.progress.transferredBytes === snapshot.progress.totalBytes}
                                <p class="success-copy">Verified download started.</p>
                            {:else}
                                <p class="quiet">Transfer cancelled. No download was started.</p>
                            {/if}
                        </div>
                    {/if}
                    {#if snapshot.rtcDiagnostic !== undefined}
                        {@const diagnostic = rtcStatus(snapshot.rtcDiagnostic, "receiver")}
                        <div class:failure={diagnostic.isFailure} class="diagnostic-card">
                            <h3>Direct connection</h3>
                            <p>{diagnostic.message}</p>
                            {#if diagnostic.totals !== undefined}
                                <p class="diagnostic-totals">{diagnostic.totals}</p>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        </section>
    {/if}

    <aside class="security-note">
        <strong>Keep the number temporary.</strong>
        A Pitch number is convenient, but has limited entropy. The sender still decides whether
        to accept each visitor, and files are checked before a download starts.
    </aside>

    <details class="settings">
        <summary>Nostr relay settings</summary>
        <div class="settings-body">
            <p>Enter one secure relay URL per line.</p>
            <p>The sender and visitor need at least one usable relay in common.</p>
            <label for="relay-urls">Relay URLs</label>
            <textarea id="relay-urls" bind:value={relayText} rows="5"></textarea>
            <div class="button-row">
                <button type="button" class="primary" onclick={saveRelaySettings}>
                    Save relays
                </button>
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
    </details>
</main>
