# Barrow Alley

> **Rather than tap the right brick, install Barrow Alley.**

> **Set up a pitch. Share the number. Let them choose.**

Barrow Alley is being built as an Obsidian Community Plugin for temporary, sender-approved file handoff. Its host-neutral protocol, integrity-checked transfer core, and Trystero transport are implemented, but the plug-in does not yet provide the commands and views needed to set up or visit a pitch.

The current implementation supports files up to 100 MiB each. It reads one complete file into memory while verifying it.

The plug-in settings and browser interoperability client accept one `wss://` Nostr relay URL per line. The displayed list is the complete effective list for each new pitch; blank lines and exact duplicates are removed, and an existing pitch keeps its original relay snapshot. The sender and visitor need at least one usable relay in common. Nostr relays carry discovery and signalling data, while file content uses the direct WebRTC connection.

This repository also contains a small browser interoperability client under `test/web`. It is used to test the Barrow Alley protocol without Obsidian and is published as a convenience client.

See [DESIGN.md](DESIGN.md) for the complete product and implementation design.
