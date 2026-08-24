# Barrow Alley

> **Set up a pitch. Share the number. Let them choose.**

Barrow Alley is an Obsidian plug-in for temporary, sender-approved file handoff. A sender selects files and shares an eight-digit Pitch number. The sender must then accept the visitor before any file details are disclosed. The accepted visitor chooses which files to receive.

> [!TIP]
> Incidentally, Barrow Alley and [Screwdriver](https://github.com/vrtmrz/obsidian-screwdriver) make a handy, rough-and-ready way to test an Obsidian plug-in under development: pack its build into a note with Screwdriver, hand that note over with Barrow Alley, then restore it in a test Vault.

Barrow Alley requires Obsidian 1.8.7 or later.

## Set up a pitch

Use one of the following Obsidian commands or File Explorer actions:

- **Barrow Alley: Set up a pitch for current file**
- **Barrow Alley: Set up a pitch for selected files**
- **Set up a pitch for this file** from a file menu
- **Set up a pitch for selected files** from a multiple-file menu

Barrow Alley reads and checks the selected files, then displays the temporary Pitch number. Keep the pitch open while the visitor connects. Choose **Accept** to disclose the file list to that visitor, or **Deny** to refuse the request. **Close the pitch** ends the session.

## Receive files in Obsidian

Run **Barrow Alley: Receive files**, enter the Pitch number with the on-screen keypad, and choose a destination folder. After the sender accepts the request, choose files from the disclosed list. Once the connection dialogue is open, it remains open if discovery or direct connection fails so that you can review the status and try another number.

When a destination name already exists, Barrow Alley offers to save with another name, overwrite, skip, or cancel. It does not overwrite a Vault file without an explicit choice. The received size and SHA-256 digest are checked before a complete file is saved.

## Browser client

To send files from this device to an Obsidian Vault—or receive files here from a Vault—[open Barrow Alley for the web](https://vrtmrz.github.io/barrow-alley/). The current version of Chrome is recommended.

This repository contains the browser client under `test/web`. It also serves as a small interoperability harness and is built separately from the Obsidian plug-in.

## Network and relay settings

Barrow Alley uses configurable Nostr relays for discovery and signalling. File content is sent between the devices after a WebRTC connection is established; it is not uploaded to or stored on an intermediary storage service.

The Obsidian settings and browser client accept one secure `wss://` Nostr relay URL per line. The displayed list is the complete effective list for each new pitch. Blank lines and exact duplicates are removed, and an existing pitch keeps the relay list with which it started. The sender and visitor need at least one usable relay in common.

Barrow Alley does not provide a TURN relay. A direct connection may therefore fail because of firewalls, carrier networks, or NAT behaviour even when both devices can reach the same Nostr relay. The connection dialogue reports discovery, direct-connection progress, and classified failures where available.

## Privacy and security boundaries

- A Pitch number has limited entropy and is not strong authentication. Knowing it permits a connection request; the sender's explicit acceptance permits access to the file list and requested files.
- Before acceptance, Barrow Alley does not send file names, paths, sizes, MIME types, hashes, Vault information, or file content to the visitor.
- Manifest entries contain safe display names rather than absolute paths or complete Vault paths.
- Nostr relays carry discovery and signalling data, not file content. This does not mean that connection metadata is absent from every network service.
- RTC diagnostics omit SDP, candidate addresses, candidate IDs, raw WebRTC statistics, Vault information, and file metadata.

## Current limits

- Each file is limited to 100 MiB.
- Barrow Alley reads or buffers one complete file at a time for hashing, transfer, or integrity verification. Memory-constrained devices may need smaller files.
- Transfers are sequential within a pitch.
- Successful transfer depends on the two devices establishing a WebRTC connection.

See [DESIGN.md](DESIGN.md) for the complete product and implementation design, and [CONTRIBUTING.md](CONTRIBUTING.md) for development and validation commands.

Barrow Alley is available under the [MIT licence](LICENSE).
