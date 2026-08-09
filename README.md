# Barrow Alley

> **Rather than tap the right brick, install Barrow Alley.**

> **Set up a pitch. Share the number. Let them choose.**

Barrow Alley is being built as an Obsidian Community Plugin for temporary, sender-approved file handoff. Its host-neutral protocol, integrity-checked transfer core, Trystero transport, and Obsidian sender flow are implemented. The plug-in can set up a pitch for the current file, a File Explorer selection, or files chosen in its multi-file picker; the Obsidian receiver flow is not yet implemented.

The current implementation supports files up to 100 MiB each. It reads one complete file into memory while verifying it.

The plug-in settings and browser interoperability client accept one `wss://` Nostr relay URL per line. The displayed list is the complete effective list for each new pitch; blank lines and exact duplicates are removed, and an existing pitch keeps its original relay snapshot. The sender and visitor need at least one usable relay in common. Nostr relays carry discovery and signalling data, while file content uses the direct WebRTC connection.

The Obsidian sender's waiting dialogue uses local WebRTC state and aggregate connection counters to show direct-connection attempts, progress, and failures. These diagnostics do not include SDP, candidate addresses, candidate IDs, raw WebRTC statistics, Vault information, or file metadata.

This repository also contains a small browser interoperability client under `test/web`. It is intended to test the Barrow Alley protocol without Obsidian and, once complete, provide a convenience client.

See [DESIGN.md](DESIGN.md) for the complete product and implementation design.
