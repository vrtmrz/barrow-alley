# Barrow Alley

> **Rather than tap the right brick, install Barrow Alley.**

> **Set up a pitch. Share the number. Let them choose.**

Barrow Alley is an Obsidian plug-in for temporary, sender-approved file handoff. It can set up a pitch for the current file, a File Explorer selection, or files chosen in its multi-file picker. It can also receive files into a chosen Vault folder, with explicit conflict handling and integrity verification before saving.

The current implementation supports files up to 100 MiB each. It reads one complete file into memory while verifying it.

The plug-in settings and browser interoperability client accept one `wss://` Nostr relay URL per line. The displayed list is the complete effective list for each new pitch; blank lines and exact duplicates are removed, and an existing pitch keeps its original relay snapshot. The sender and visitor need at least one usable relay in common. Nostr relays carry discovery and signalling data, while file content uses the direct WebRTC connection.

The Obsidian sender's waiting dialogue uses local WebRTC state and aggregate connection counters to show direct-connection attempts, progress, and failures. These diagnostics do not include SDP, candidate addresses, candidate IDs, raw WebRTC statistics, Vault information, or file metadata.

This repository also contains a small browser interoperability client under `test/web`. It can set up or visit a pitch, and is built separately from the Obsidian plug-in. It is intended for protocol interoperability testing and as a convenience client; it is not currently deployed by this repository.

See [DESIGN.md](DESIGN.md) for the complete product and implementation design.
