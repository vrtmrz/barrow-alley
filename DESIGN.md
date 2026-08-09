# Barrow Alley — Design and Implementation Guide

> **Set up a pitch. Share the number. Let them choose.**

Status: Draft baseline for implementation  
Primary product: Obsidian Community Plugin  
Secondary product: Browser interoperability test client  
Audience: Maintainers and contributors

---

## 1. Purpose

Barrow Alley is a temporary peer-to-peer file handoff tool for Obsidian and web browsers.

A sender selects or drops one or more files and sets up a short-lived pitch. The sender receives an eight-digit Pitch number. A receiver enters that number, requests a connection, and waits for the sender to accept or deny the request. Only after acceptance does the receiver see the available files. The receiver then chooses which files to retrieve.

The product is deliberately not modelled as “push files to another device”. Its interaction model is:

1. Set up a pitch for selected files.
2. Share the Pitch number.
3. Admit one receiver.
4. Let the receiver choose what to take.
5. Close the pitch when the sender closes the Barrow Alley UI.

The primary implementation is an Obsidian Community Plugin. A small browser client lives in the same repository under `test/web` as an interoperability test tool and convenience client.

---

## 2. Product identity

### Name

**Barrow Alley**

### Tagline

> **Set up a pitch. Share the number. Let them choose.**

### Meaning

Barrow Alley uses the limited user-facing metaphor of a temporary pitch: the sender sets it up, and a visitor chooses the files they need. The metaphor stops at *pitch* and *visitor*; security explanations and state messages must remain direct and unambiguous.

### Core language

Prefer these terms consistently in UI, code, and documentation:

| Concept | Preferred term |
|---|---|
| Product | Barrow Alley |
| Files made available by the sender | files |
| User-facing temporary availability | pitch |
| Eight-digit code | Pitch number |
| Compact number heading | Pitch No. |
| Connecting requester in user-facing copy | visitor |
| Start temporary availability | set up a pitch |
| Sender decision | accept / deny |
| Receiver file list in user-facing copy | files |
| Receiver file index in technical contexts | manifest |
| End temporary availability | close the pitch |

Keep technical identifiers direct: use `session`, `sender`, `receiver`, `peer`, `manifest`, and `transport`. Do not extend the market metaphor to identifiers or terms such as *wares* or *stock*.

Do not call the Pitch number a secure key, secret, authentication token, or encryption key.

---

## 3. Scope

### 3.1 Initial release

The initial release supports:

- Obsidian as a sender.
- Obsidian as a receiver.
- A browser as a sender.
- A browser as a receiver.
- Obsidian-to-browser transfer.
- Browser-to-Obsidian transfer.
- Obsidian-to-Obsidian transfer.
- Browser-to-browser transfer.
- Multiple files in one session.
- Receiver-side selection of individual files.
- A one-sender, one-receiver session.
- An eight-digit Pitch number.
- Explicit sender-side Accept or Deny.
- WebRTC DataChannel file transfer through Trystero.
- Nostr relays for discovery and signalling.
- User-configurable Nostr relay URLs.
- Direct transfer without server-side file storage.
- Size and cryptographic hash verification.
- Clear cancellation and failure states.
- Session termination when the sender closes the pitch.

### 3.2 Explicit non-goals for the initial release

Do not implement these unless the maintainer explicitly changes the scope:

- A separate long random token.
- URL-fragment secrets.
- A second “strong link” connection path.
- Persistent device pairing.
- Accounts or identities.
- Contact lists.
- Transfer history.
- Cloud file storage.
- Server-side relay transfer.
- TURN service bundled or operated by the project.
- Resumable transfer.
- Folder transfer.
- Directory structure preservation.
- Vault synchronisation.
- Background receiving.
- Multiple simultaneous receivers.
- Public long-lived download links.
- Automatic acceptance.
- A standalone production web application repository.
- A package workspace or monorepo.
- Premature extraction of `barrow-alley-core` into a separately published npm package.

The browser client is useful, but the Obsidian plugin remains the primary product and repository shape.

---

## 4. User experience

## 4.1 Sender flow

### Obsidian entry points

Initial commands should include:

- `Barrow Alley: Set up a pitch for current file`
- `Barrow Alley: Set up a pitch for selected files`
- `Barrow Alley: Open Barrow Alley`
- `Barrow Alley: Receive files`

Where practical, add file-menu actions for the current file and selected files.

Do not make “current note plus every referenced attachment” part of the first implementation. It can be added after the basic transfer path is stable.

### Browser entry point

The browser page shows a file drop target and a Pitch-number input. It may use tabs or two plainly labelled sections:

- **Set up a pitch**
- **Receive files**

Sending should require no account or setup beyond the relay defaults.

### Sender sequence

1. The sender selects or drops files.
2. Barrow Alley validates the selection.
3. Barrow Alley creates a sender session.
4. A cryptographically random Pitch number is generated.
5. The number is used to derive the Trystero room/passphrase inputs.
6. The UI displays the number and waits for a peer.
7. A receiver enters the number and reaches the room.
8. The sender sees a connection request.
9. The sender chooses Accept or Deny.
10. On Accept, the session becomes exclusive to that peer.
11. Only then is the manifest sent.
12. The sender serves requested files.
13. Closing the sender UI closes the session and active transfers.

Suggested copy:

```text
Pitch set up with 3 files

Pitch No.

1234 5678

Waiting for a visitor…
```

Connection request:

```text
A visitor is requesting access.

Allow this visitor to view the files?

[Accept] [Deny]
```

### Accept semantics

Accept must:

- Mark exactly one peer as authorised.
- Stop accepting additional peers for the session.
- Prevent any unauthorised peer from receiving the manifest or file data.
- Send the manifest only to the authorised peer.
- Update the sender UI to show that the pitch is open to the accepted peer.

### Deny semantics

Deny must:

- Send no manifest.
- Send no file metadata.
- Send no file content.
- Disconnect or reject the requesting peer.
- Return the sender to a waiting state unless the sender closes the session.

A short burst of repeated denied requests may trigger an informative warning, but automated lockout is not required in the first release.

---

## 4.2 Receiver flow

1. The receiver chooses **Receive files**.
2. The receiver enters an eight-digit Pitch number.
3. Barrow Alley validates the format locally.
4. The receiver joins the corresponding room.
5. The UI says that sender approval is pending.
6. If denied, the UI reports denial and returns to number entry.
7. If accepted, the receiver obtains the manifest.
8. The UI lists the available files.
9. The receiver selects a file to retrieve.
10. The receiver sees per-file progress.
11. The file is saved only after integrity checks pass.

Suggested copy:

```text
Enter a Pitch number

[ 1234 5678 ]

[Request access]
```

Pending:

```text
Waiting for the sender to accept…
```

Manifest:

```text
Available files

notes.md        12 KB
diagram.png    420 KB
report.pdf     2.4 MB
```

For the first release, clicking a file may start its download immediately. A `Receive all` action is optional and should not delay the basic implementation.

---

## 4.3 Closing behaviour

Closing the sender’s pitch view, modal, or browser page must be treated as an intentional session shutdown.

Shutdown must:

- Abort open UI interactions.
- Stop Nostr subscriptions used by the session.
- Close Trystero/WebRTC peer connections.
- Cancel pending file reads.
- Cancel active writes.
- Reject later actions against the closed session.
- Remove all session-owned timers and listeners.
- Mark partial incoming files as failed and clean them up where possible.

The product promise is: **the pitch exists only while the sender keeps it open**.

---

## 5. Security and trust model

## 5.1 The Pitch number

An eight-digit numeric space has limited entropy. It must not be presented as strong authentication.

The number is a short-lived rendezvous identifier. It allows a receiver to send a connection request to the correct sender session. It does not by itself grant access to the manifest or files.

Security boundary:

```text
Knowing the number
    permits a connection request.

Sender acceptance
    permits access to the manifest and requested files.
```

Use a cryptographically secure random-number source to generate the eight digits. Do not use `Math.random()`.

No separate long random token is used in the initial design.

## 5.2 Information disclosure boundary

Before the sender accepts a receiver, do not transmit:

- File names.
- File paths.
- File sizes.
- MIME types.
- Hashes.
- Vault names.
- Vault-relative paths.
- File contents.
- Notes about the files.

A pre-accept message may contain only protocol-level information needed to request admission, such as protocol version and a generic client kind.

## 5.3 Encryption claims

WebRTC and Trystero provide the transport and encryption mechanisms used by the implementation. Documentation should avoid making stronger claims than the implementation establishes.

Allowed wording:

- Files travel directly between peers when a WebRTC connection is established.
- Files are not uploaded to a Barrow Alley-operated file server.
- Nostr relays are used for discovery and signalling, not for file content.
- The sender must accept the receiver before file details are disclosed.

Avoid wording such as:

- “The Pitch number is unbreakable.”
- “End-to-end secure against all attackers.”
- “Anonymous.”
- “No metadata is exposed anywhere.”
- “Guaranteed direct connection.”

## 5.4 Path handling

Manifest entries should expose only the minimum useful name.

Initial manifest item:

```ts
export interface ManifestItem {
  id: string;
  displayName: string;
  size: number;
  mimeType?: string;
  hash: string;
}
```

Do not send an absolute filesystem path.

Do not send a full Vault path unless a later feature explicitly requires directory preservation. If duplicate display names must be distinguished, create a safe display label without exposing unrelated parent paths.

## 5.5 File mutation

A source file may change after the manifest is built.

The transfer layer must detect this by at least one of:

- Re-checking size and modification metadata before transfer.
- Computing the final hash from the bytes actually sent and reporting it.
- Rejecting when the sent-byte hash differs from the manifest hash.

The simplest safe initial policy is:

1. Compute metadata and hash while preparing the manifest.
2. At transfer time, read a fresh whole-file snapshot and calculate its hash.
3. Verify that the snapshot size and hash still match the manifest.
4. Abort if the transfer-time hash differs from the manifest hash.
5. Tell the user to set up a new pitch.

---

## 6. Network design

## 6.1 Trystero

Use Trystero for:

- Peer discovery.
- Signalling through configured Nostr relays.
- WebRTC connection establishment.
- DataChannel messaging.
- Peer-specific actions.
- Connection and disconnection events.

Barrow Alley uses one short Trystero action and awaits each action sender Promise
as transport backpressure. Trystero treats a top-level typed array as binary but
JSON-serialises an object containing one. The transport adapter therefore sends
`file-chunk.data` as the top-level binary payload and puts the remaining validated
frame fields in a versioned Trystero metadata envelope. It reconstructs the
domain message before the normal untrusted-message validator sees it.

`room.leave()` owns per-pitch cleanup: it removes the room's Nostr subscriptions
and closes its WebRTC peers. Trystero may retain a module-level relay WebSocket
for reuse by another room, so a pitch must not pause or close that shared socket.

LiveSync already contains relevant implementation experience. Reuse concepts or narrowly extracted code where appropriate, especially around:

- Trystero lifecycle.
- Chunked transfer.
- Progress.
- Cancellation.
- Hashing.
- Backpressure.
- Cleanup after disconnect.

Do not import LiveSync’s synchronisation domain, database model, replication state, or conflict handling into Barrow Alley.

## 6.2 Nostr relays

Relay URLs are user-configurable.

### Obsidian settings

Add a Barrow Alley settings tab with:

- A multiline relay URL field.
- One relay URL per line.
- A `Restore defaults` action.
- Explanatory text that sender and visitor must share at least one usable relay.
- Validation feedback.

Rules:

- Accept `wss://` URLs only.
- Trim whitespace.
- Ignore blank lines.
- Remove exact duplicates.
- Require at least one valid relay.
- Preserve order.
- Apply changed settings to newly created sessions.
- Do not mutate an already-open session’s relay set.

Suggested data model:

```ts
export interface RelaySettings {
  readonly relays: readonly string[];
}
```

Keep the first version simple: the list displayed in settings is the complete effective list. Do not introduce “built-in plus extra”, per-session overrides, relay priorities, authentication, or relay health scoring.

### Browser test client

Provide the same relay list under a small settings control.

Store it in `localStorage`.

The browser UI must explain:

> The sender and visitor need at least one usable relay in common.

The browser test client should use the same validation function as the plugin where possible.

### Defaults

Ship a small default list so the plugin works without initial configuration. Keep defaults in one shared source file.

Relay defaults are operational defaults, not protocol constants. They may change between releases.

## 6.3 Relay errors

Distinguish these states where practical:

- No valid relays configured.
- Could not open any relay connection.
- Room not found before timeout.
- Peer reached the room but WebRTC could not connect.
- Peer disconnected after connection.

These are local `ConnectionError` classifications rather than peer-visible wire
errors. An invalid effective list prevents room creation. A relay-open timeout is
`RELAY_UNAVAILABLE`; a peer-discovery timeout is `ROOM_NOT_FOUND`; Trystero's
join callback maps handshake, password, ICE, and direct-connection failures to
`WEBRTC_CONNECTION_FAILED`; and a targeted action which has lost its peer maps
to `PEER_DISCONNECTED`. A relay mismatch and an absent pitch are intentionally
indistinguishable at the room-discovery boundary.

Do not provide a misleading `Test relays` button that implies full end-to-end compatibility. A future diagnostics screen may report connection and publish/subscribe observations, but it is not required initially.

### WebRTC diagnostics

Wrap each Barrow Alley Trystero room's `RTCPeerConnection` constructor with the
diagnostic approach used in Self-hosted LiveSync. Keep the wrapper scoped to
that room rather than replacing the global constructor. It may observe
connection, ICE connection, ICE gathering, and signalling state histories, and
selected candidate-pair counters from `getStats()`.

Diagnostic events are local presentation information, not protocol messages.
They must not expose SDP, candidate addresses, candidate IDs, raw `getStats()`
reports, Vault information, or file metadata. Observer failures must not alter
the WebRTC lifecycle. A diagnostic can explain a failed direct connection, but
must not claim that relay availability alone proves end-to-end connectivity.
The sender's waiting dialogue may show a sanitised connection-attempt count,
state summary, and failure explanation. Keep this display separate from the
protocol session state so diagnostic delivery cannot control pitch behaviour.

## 6.4 STUN and TURN

The initial release does not operate or bundle a TURN relay.

Use the normal STUN facilities configured by Trystero or the application. If peers cannot establish a direct connection, fail clearly.

Suggested message:

```text
A direct connection could not be established.

Try placing both devices on the same Wi-Fi network,
using a mobile hotspot, or changing networks.

This version does not support relay transfer.
```

A user-configurable TURN option is outside the initial scope.

---

## 7. Protocol

## 7.1 Protocol version

Every peer-level control message must carry or be associated with an explicit protocol version.

```ts
export const BARROW_ALLEY_PROTOCOL_VERSION = 1;
```

Reject incompatible versions with a clear message. Do not silently continue.

## 7.2 Message families

The concrete Trystero action names may be shortened, but the domain model should represent at least:

```text
hello
connection-request
accept
deny
manifest
request-file
file-begin
file-chunk
file-end
cancel-file
cancel-session
complete
error
```

Keep admission messages separate from post-admission file messages.

## 7.3 Suggested message shapes

```ts
export interface HelloMessage {
  protocolVersion: number;
  clientKind: "obsidian" | "browser";
}

export interface ConnectionRequestMessage {
  protocolVersion: number;
  clientKind: "obsidian" | "browser";
}

export interface AcceptMessage {
  protocolVersion: number;
  sessionId: string;
}

export interface DenyMessage {
  protocolVersion: number;
  reason?: "denied" | "busy" | "incompatible";
}

export interface Manifest {
  protocolVersion: number;
  sessionId: string;
  items: ManifestItem[];
}

export interface RequestFileMessage {
  sessionId: string;
  fileId: string;
}

export interface FileBeginMessage {
  sessionId: string;
  fileId: string;
  displayName: string;
  size: number;
  hash: string;
  chunkSize: number;
}

export interface FileChunkMessage {
  sessionId: string;
  fileId: string;
  index: number;
  offset: number;
  data: Uint8Array;
}

export interface FileEndMessage {
  sessionId: string;
  fileId: string;
  bytesSent: number;
  hash: string;
}
```

Do not trust IDs or sizes received over the peer connection. Validate all messages.

## 7.4 Manifest IDs

Generate opaque, per-session item IDs. They need not be secret, but they must not expose local paths or stable identifiers from the Vault.

A receiver requests a file only by its manifest item ID.

## 7.5 Transfer order

Initial policy:

- One active file transfer per session.
- Files transfer sequentially.
- The receiver may queue another file while one is active, but concurrent streams are not required.
- Duplicate requests for the same active file are rejected or coalesced.
- Requests for unknown IDs are rejected.

Sequential transfer simplifies:

- Memory use.
- Backpressure.
- Progress display.
- Cancellation.
- Error handling.
- Mobile reliability.

## 7.6 Chunking and backpressure

The initial implementation deliberately reads one complete file because the
cross-platform Obsidian binary APIs do not provide a portable partial-read
contract. Use Web Crypto to hash that complete byte array. Apply an explicit
100 MiB per-file limit while this buffering model is in use.

The transfer layer should:

- Keep at most one source file active per session.
- Split the complete source snapshot into bounded chunks for transport.
- Observe DataChannel buffering or use an explicit acknowledgement/window mechanism.
- Avoid unbounded producer queues.
- Await transport capacity before offering the next chunk.
- Calculate SHA-256 over the complete source and received byte arrays.
- Allow cancellation between chunks.

Start with 64 KiB chunks, keep the size configurable internally, and reject an
individual incoming chunk larger than 1 MiB. These values are implementation
safety limits rather than protocol-version constants and may be adjusted after
real Trystero and mobile measurements.

Trystero applies its own lower-level chunking to an action payload. Barrow Alley
keeps the 64 KiB domain frame because awaiting each action sender Promise still
bounds queued work and avoids depending on Trystero's private chunk size.

## 7.7 Integrity

A completed incoming file is valid only when all are true:

- Received byte count equals the declared size.
- No chunk is missing.
- No chunk range overlaps unexpectedly.
- Final calculated hash equals the expected hash.
- The sender reports the same bytes and hash.
- The destination writer completes successfully.

Use SHA-256 unless the existing LiveSync implementation provides a well-tested equivalent with a clear reason to reuse it.

A failed integrity check must not leave a normal-looking completed file in the Vault.

---

## 8. State machines

Keep session state in explicit domain objects. Do not infer it from visible UI elements or scattered booleans.

## 8.1 Sender state

```text
idle
  -> preparing
  -> waiting-for-peer
  -> approval-pending
       -> waiting-for-peer        (deny)
       -> connected               (accept)
  -> serving
  -> transferring
       -> serving                 (complete/cancel)
  -> closing
  -> closed

Any active state
  -> failed
  -> closing
  -> closed
```

Required invariants:

- Manifest cannot be sent before `connected`.
- Only the authorised peer may cause `serving -> transferring`.
- At most one transfer is active.
- `closed` is terminal.
- Closing is idempotent.
- Denied peers never become authorised without a new request.
- A second peer cannot replace the accepted peer.

## 8.2 Receiver state

```text
idle
  -> connecting
  -> awaiting-approval
       -> denied
       -> loading-manifest
  -> browsing
  -> receiving
       -> browsing                (complete/cancel)
  -> closing
  -> closed

Any active state
  -> failed
  -> closing
  -> closed
```

Required invariants:

- The receiver cannot request a file before a valid manifest.
- Only manifest IDs can be requested.
- At most one receive writer is active.
- A failed hash never produces a completed destination.
- `closed` is terminal.
- Closing is idempotent.

---

## 9. Repository shape

This is a normal Obsidian plugin repository, not a monorepo.

Use one root `package.json` and one lockfile.

Suggested layout:

```text
barrow-alley/
├─ manifest.json
├─ versions.json
├─ README.md
├─ DESIGN.md
├─ AGENTS.md
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ esbuild.config.mjs
├─ styles.css
│
├─ src/
│  ├─ main.ts
│  │
│  ├─ core/
│  │  ├─ protocol/
│  │  │  ├─ version.ts
│  │  │  ├─ messages.ts
│  │  │  ├─ validation.ts
│  │  │  └─ errors.ts
│  │  ├─ session/
│  │  │  ├─ sender-session.ts
│  │  │  ├─ receiver-session.ts
│  │  │  └─ state.ts
│  │  ├─ transfer/
│  │  │  ├─ sender.ts
│  │  │  ├─ receiver.ts
│  │  │  ├─ integrity.ts
│  │  │  └─ progress.ts
│  │  ├─ manifest.ts
│  │  └─ settings.ts
│  │
│  ├─ transport/
│  │  ├─ transport.ts
│  │  ├─ trystero-transport.ts
│  │  └─ relay-settings.ts
│  │
│  └─ obsidian/
│     ├─ commands.ts
│     ├─ settings-tab.ts
│     ├─ pitch-view.ts
│     ├─ receive-view.ts
│     ├─ vault-source.ts
│     ├─ vault-sink.ts
│     └─ ui.ts
│
├─ test/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  │
│  └─ web/
│     ├─ index.html
│     ├─ vite.config.ts
│     ├─ tsconfig.json
│     └─ src/
│        ├─ main.ts
│        ├─ App.svelte
│        ├─ components/
│        │  ├─ DropZone.svelte
│        │  ├─ NumberEntry.svelte
│        │  ├─ PitchStatus.svelte
│        │  ├─ ApprovalPanel.svelte
│        │  ├─ ManifestList.svelte
│        │  ├─ TransferRow.svelte
│        │  └─ RelaySettings.svelte
│        ├─ browser-source.ts
│        ├─ browser-sink.ts
│        └─ storage.ts
│
└─ .github/
   └─ workflows/
      ├─ check.yml
      ├─ release.yml
      └─ deploy-test-web.yml
```

The exact file count may be reduced during implementation. Preserve the dependency boundaries even if some modules begin in the same file.

---

## 10. Dependency boundaries

## 10.1 `src/core`

`src/core` must not import:

- `obsidian`
- Svelte
- DOM-specific modules
- Browser download APIs
- Obsidian `App`, `Vault`, or `TFile`
- UI component classes

It may depend on small capability interfaces.

Suggested source and sink boundaries:

```ts
export interface SourceItem {
  id: string;
  displayName: string;
  size: number;
  mimeType?: string;
  sourceVersion?: string;
}

export interface Source {
  list(): Promise<readonly SourceItem[]>;
  open(itemId: string): Promise<Uint8Array>;
}

export interface IncomingFileMeta {
  id: string;
  displayName: string;
  size: number;
  mimeType?: string;
  hash: string;
}

export interface IncomingFileWriter {
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface Sink {
  begin(meta: IncomingFileMeta): Promise<IncomingFileWriter>;
}
```

Adjust for actual host support, but keep core independent of host file types.

## 10.2 `src/transport`

Define a narrow transport interface before implementing the Trystero adapter.

Tests should be able to use an in-memory transport.

The core session logic should not know about Nostr event structures or WebRTC implementation details.

## 10.3 `src/obsidian`

Owns:

- Plugin lifecycle.
- Commands.
- Settings tab.
- Views and modals.
- Vault file enumeration.
- Binary file reads and writes.
- Destination conflict policy.
- Obsidian notices and progress UI.
- Fancy Kit composition.

## 10.4 `test/web`

May import:

- `src/core`
- `src/transport`
- Shared relay validation/defaults

Must not import:

- `src/main.ts`
- `src/obsidian/**`
- `obsidian`

Add a lint or dependency-boundary test to prevent accidental Obsidian imports from the browser app.

## 10.5 Runtime global boundary

Keep browser and Node.js global-object access behind `src/compat-global.ts`.
This is the sole reviewed compatibility workaround for host-neutral core and
transport code which runs both in Obsidian and in the Node.js interoperability
tests. Other production modules must not add direct `globalThis` access or
local lint suppressions.

---

## 11. Fancy Kit use

Use Fancy Kit for interaction contracts, notifications, progress, and testable workflows.

Good uses:

- Prompting for a Pitch number.
- Accept/Deny confirmation.
- Error and explanatory messages.
- Keyed connection-status notifications.
- Transfer progress.
- Scripted interaction tests.
- Shared browser/Obsidian workflow boundaries.

Do not force every persistent Barrow Alley screen through a generic dialogue abstraction.

Use Barrow Alley-owned UI for:

- The open sender session.
- The large Pitch number.
- The visible file manifest.
- Persistent connection status.
- Multiple transfer rows.
- Browser drop zone.
- Browser relay settings.

Recommended division:

```text
Fancy Kit
  interaction questions, notifications, progress, test drivers

Barrow Alley UI
  persistent product state and file-list presentation
```

The Obsidian plugin may use a dedicated view or modal. The browser client may use Svelte 5 and Vite.

Do not add generic components to Fancy Kit unless another real consumer exists or the component is clearly host-neutral and reusable.

---

## 12. Obsidian storage behaviour

## 12.1 Incoming destination

The receiver must choose or have a configured destination folder.

Initial policy may be:

- A configurable default folder.
- Prompt when not configured.
- Save browser-originated files to that folder.
- Preserve only the safe display filename.

## 12.2 Name conflicts

For an incoming path that already exists, offer:

- Save with another name.
- Overwrite.
- Skip.
- Cancel transfer.

Default to a non-destructive action.

Do not silently overwrite.

## 12.3 Partial files

Preferred behaviour:

1. Write to a temporary or clearly partial destination.
2. Verify byte count and hash.
3. Commit to the final name.
4. Remove the partial file on failure.

If Obsidian APIs make atomic rename impractical across all platforms, choose the safest implementable strategy and document its limitations. Do not present a partial file as complete.

For the minimum supported Obsidian 1.8.7 API, Barrow Alley buffers one incoming
file in memory and creates no Vault entry until the receiver core has verified
its byte count and SHA-256 digest. Completion then uses `Vault.createBinary`, or
`Vault.modifyBinary` only after explicit overwrite confirmation. The destination
is checked again immediately before that call so a file which appears or changes
during transfer is not silently overwritten. A failed or cancelled transfer
therefore leaves no partial Vault file, but the core and Vault adapter may retain
complete in-memory representations of the active file. Transfers remain
sequential, and the 100 MiB per-file limit bounds this mobile-relevant trade-off.

## 12.4 Fancy Kit Vault capability

Do not expand Fancy Kit’s text/frontmatter Vault boundary merely to accommodate Barrow Alley binary writes. Keep binary transfer and destination policy owned by the Barrow Alley Obsidian adapter.

---

## 13. Browser interoperability client

## 13.1 Purpose

`test/web` is:

- A protocol interoperability test client.
- A manual browser compatibility harness.
- A convenient minimal web client for users.
- A way to test the protocol without launching two Obsidian instances.

It is not a separate architectural product and does not justify a monorepo.

README wording should be candid:

> This repository also contains a small browser interoperability client under `test/web`. It is intended to test the Barrow Alley protocol without Obsidian and, once complete, provide a convenience client.

## 13.2 Functionality

Keep it deliberately small:

Sender:

- Drop or select files.
- Display the Pitch number.
- Accept or deny a receiver.
- Show transfer status.
- Close the session by leaving or closing the page.

Receiver:

- Enter a Pitch number.
- Wait for acceptance.
- Display the manifest.
- Click a file to download it.
- Show transfer status and errors.

Settings:

- Edit Nostr relay URLs.
- Restore defaults.
- Save in `localStorage`.

## 13.3 Build

Use the root package and lockfile.

Example scripts:

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "lint": "node --max-old-space-size=3072 ./node_modules/eslint/bin/eslint.js src",
    "test": "vitest run",
    "test:watch": "vitest",
    "web:dev": "vite --config test/web/vite.config.ts",
    "web:build": "vite build --config test/web/vite.config.ts",
    "check": "npm run lint && npm run test && npm run build",
    "check:web": "npm run web:build"
  }
}
```

The exact script names can follow repository conventions.

Keep `build` as the production plug-in build because the Community Directory
scanner uses the first recognised build script. Tests and Node-only tooling stay
under the exact root names `test` and `scripts`, which the scanner excludes.
Local lint targets production `src`; Vitest and the test TypeScript project
validate `test` separately. Keep the browser build and check out of the plug-in
gate; run `check:web` as a separate validation and CI step. The lint script
must apply the repository's 3 GB V8 heap limit to ESLint itself.

Build output for the web client should be separate from plugin release assets, for example `dist-web/`.

## 13.4 Publishing

Plugin release assets:

```text
manifest.json
main.js
styles.css        (when present)
```

Do not include the browser test bundle in the Obsidian plugin release.

The browser client may be deployed separately through GitHub Pages or another static host. Its deployment must not block plugin packaging.

---

## 14. Error model

Use typed domain errors. Avoid passing arbitrary strings through every layer.

Suggested categories:

```ts
export type ErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_NUMBER"
  | "NO_RELAYS"
  | "RELAY_UNAVAILABLE"
  | "SESSION_NOT_FOUND"
  | "APPROVAL_TIMEOUT"
  | "DENIED"
  | "BUSY"
  | "INCOMPATIBLE_PROTOCOL"
  | "DIRECT_CONNECTION_FAILED"
  | "PEER_DISCONNECTED"
  | "UNKNOWN_FILE"
  | "SOURCE_CHANGED"
  | "TRANSFER_CANCELLED"
  | "TRANSFER_FAILED"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "DESTINATION_CONFLICT"
  | "DESTINATION_FAILED"
  | "SESSION_CLOSED";
```

Milestones 1 and 2 use the following peer-visible subset. These codes describe what
may safely be reported across the peer boundary; they do not expose arbitrary
exception text.

| Code | When it applies | Boundary and disclosure rule |
| --- | --- | --- |
| `INVALID_MESSAGE` | A payload is structurally invalid, contains an unsupported value in a validated field or an unknown message type, or uses a recognised message type which the receiving role does not accept in that context. | A missing or malformed `protocolVersion` is invalid rather than incompatible. Local diagnostic text is not sent to the peer. |
| `INCOMPATIBLE_PROTOCOL` | `protocolVersion` is a valid integer which the receiver does not support. | An incompatible `connection-request` is answered with `deny.reason = "incompatible"`; other control messages may receive this error code. |
| `BUSY` | The accepted peer requests another file while one transfer is active. | A competing admission request is answered with `deny.reason = "busy"` because that peer has not been accepted. |
| `UNKNOWN_FILE` | The accepted peer requests an ID which is absent from its disclosed manifest. | The receiver rejects an undisclosed ID locally before sending a request. The sender uses this code only after peer and session authorisation checks pass. |
| `SESSION_CLOSED` | The requested session is unavailable to the requesting peer. | This also covers an unauthorised peer, a wrong session ID, and a sender state which cannot serve files. The shared response avoids confirming whether a guessed file ID exists. |
| `SOURCE_CHANGED` | A fresh source snapshot differs in size or SHA-256 from the accepted manifest. | No file frame is sent until this preflight check succeeds. The pitch must be set up again. |
| `TRANSFER_CANCELLED` | The active file transfer was intentionally stopped. | Per-file cancellation preserves the accepted session and manifest; session cancellation closes them. |
| `TRANSFER_FAILED` | Chunk order, byte ranges, framing, or another transfer invariant fails without a more specific code. | Arbitrary local exception text is not sent to the peer. |
| `SIZE_MISMATCH` | Manifest, sender, or receiver byte counts disagree. | The partial destination is aborted and is never completed. |
| `HASH_MISMATCH` | Manifest, sender, or receiver SHA-256 values disagree. | The partial destination is aborted and is never completed. |
| `DESTINATION_FAILED` | The receiver cannot create, write, complete, or clean up its destination. | The sender receives only the stable code, not host paths or exception text. |

`ProtocolValidationErrorCode` is a local parser classification. The session
layer decides whether to map it to an `ErrorMessage`, an admission
`DenyMessage`, or a local failure. By contrast, `ErrorCode` is the stable code
carried by an `ErrorMessage` on the wire.

The UI maps codes to actionable messages.

Examples:

### Session not found

```text
No active pitch was found for this Pitch number.

Check the Pitch number and make sure the sender still has the pitch open.
```

### Denied

```text
The sender did not allow this connection.
```

### Relay unavailable

```text
Barrow Alley could not connect to any configured Nostr relay.

Review the relay list in Barrow Alley settings.
```

### Sender closed

```text
The sender closed this pitch.
```

### Integrity failure

```text
The received file did not pass integrity verification.

The incomplete file was not saved as a completed file.
```

### Source changed

```text
The source file changed after the pitch was set up.

Ask the sender to set up a new pitch.
```

---

## 15. Testing strategy

## 15.1 Unit tests

Prioritise behavioural invariants over trivial getters.

Required unit coverage:

- Pitch number format and secure generation boundary.
- Relay URL parsing, normalisation, deduplication, and rejection.
- No valid relays preventing session creation at the adapter boundary.
- Protocol message validation.
- Sender state transitions.
- Receiver state transitions.
- Accept-before-manifest invariant.
- Denied peer receives no manifest.
- Only the accepted peer can request files.
- Unknown file IDs are rejected.
- One active transfer limit.
- Transfer cancellation.
- Session close idempotency.
- Chunk accounting.
- Missing chunk detection.
- Size mismatch.
- Hash mismatch.
- Source-changed detection.
- Destination abort on failure.
- Protocol-version mismatch.

## 15.2 In-memory integration tests

Create an in-memory transport pair and in-memory source/sink.

Test complete flows without Trystero:

- Sender offers one file; receiver connects; sender accepts; receiver downloads.
- Sender offers multiple files; receiver downloads only one.
- Sender denies.
- Second receiver attempts to join after acceptance.
- Sender closes while waiting.
- Sender closes during transfer.
- Receiver disconnects during transfer.
- Corrupt chunk causes hash failure.
- Source changes after manifest.

## 15.3 Fancy Kit workflow tests

Use scripted drivers for:

- Number entry.
- Accept.
- Deny.
- Overwrite/rename/skip.
- Error acknowledgement.
- Cancellation confirmation.

Do not use a real Obsidian app for logic that can be verified through the neutral interaction contracts.

## 15.4 Real interoperability tests

An automated local test uses a strfry Compose fixture and two separate `werift`
processes to exercise actual Nostr discovery, WebRTC establishment, approval,
pre-accept disclosure, and session cleanup. Production parsing remains
`wss://`-only; the adapter's explicit test policy permits `ws://` solely for a
loopback host.

Maintain a concise manual matrix:

- Chrome ↔ Chrome.
- Obsidian desktop ↔ Chrome.
- Obsidian mobile ↔ Chrome.
- Obsidian ↔ Obsidian.
- Same LAN.
- Different networks.
- Mobile hotspot.
- Known direct-connect failure environment.
- Sender closes before acceptance.
- Sender closes during transfer.
- Files with Unicode names.
- Duplicate filenames.
- Zero-byte file.
- Moderately large binary file.

Do not promise very large-file support before measuring memory use in supported Obsidian and Chrome clients.

---

## 16. Implementation milestones

Implementation should proceed milestone by milestone. Each milestone should leave the repository building and tests passing.

## Milestone 0 — Repository bootstrap and boundaries

Deliver:

- Standard Obsidian plugin scaffold at repository root.
- Root `manifest.json`.
- Root build and test scripts.
- Fancy Kit dependencies pinned consistently with repository policy.
- Svelte/Vite development dependencies for `test/web`.
- Basic `AGENTS.md`.
- Dependency-boundary test or lint rule.

Acceptance:

- Plugin builds.
- Unit test runner works.
- Empty browser harness builds.
- Browser code cannot import `obsidian` or `src/obsidian`.

Do not implement networking yet.

## Milestone 1 — Protocol, state machines, and in-memory transport

Deliver:

- Protocol version and validated message types.
- Sender and receiver state machines.
- Transport interface.
- In-memory transport.
- In-memory source and sink.
- End-to-end in-memory happy-path tests.
- Denial and close tests.

Acceptance:

- Manifest cannot be observed before Accept.
- One receiver can retrieve one selected file.
- A denied receiver sees no file metadata.
- Session cleanup is idempotent.

Do not integrate Trystero until these tests pass.

## Milestone 2 — Transfer integrity

Deliver:

- Chunk framing.
- Bounded transfer loop.
- Progress events.
- SHA-256 verification.
- Cancellation.
- Source-changed detection.
- Destination abort/cleanup semantics.

Acceptance:

- Corruption is detected.
- Missing or duplicated byte ranges fail.
- Cancellation leaves no completed file.
- Tests do not require DOM or Obsidian.

## Milestone 3 — Trystero and configurable relays

Deliver:

- Trystero transport adapter.
- Relay settings parser and defaults.
- Obsidian settings tab.
- Web `localStorage` settings adapter.
- Connection timeout and useful errors.

Acceptance:

- Two local clients with one common relay can reach approval.
- Clients with no common/usable relay fail clearly.
- Relay changes affect new sessions only.
- No file metadata is sent pre-accept.

## Milestone 4 — Obsidian sender

Deliver:

- Commands for current and selected files.
- Vault-backed source adapter.
- Sender pitch view/modal.
- Number display.
- Incoming-peer Accept/Deny.
- Sender progress.
- Close-to-stop lifecycle.

Acceptance:

- Obsidian can set up a pitch for selected files for an in-memory or browser receiver.
- Closing the UI closes the session.
- The plugin unload path closes active sessions.
- No whole-file unbounded buffering for supported source APIs.

## Milestone 5 — Obsidian receiver

Deliver:

- Number-entry command.
- Receiver state UI.
- Manifest display.
- Vault-backed sink.
- Conflict handling.
- Integrity-gated completion.

Acceptance:

- Obsidian can receive from the browser harness.
- A failed transfer does not appear as a completed file.
- Conflict policy is never silently destructive.
- Mobile-relevant APIs are considered and documented.

## Milestone 6 — Browser interoperability client

Deliver:

- Drop zone.
- Number entry.
- Sender approval UI.
- Manifest list.
- Per-file download.
- Relay settings.
- Responsive styling.
- Static build.

Acceptance:

- Browser ↔ Obsidian works in both directions.
- Browser ↔ browser works.
- Leaving the sender page closes the session as far as practical.
- The browser bundle is excluded from plugin release assets.

## Milestone 7 — Hardening and release preparation

Deliver:

- Error-copy review.
- Privacy/security documentation.
- Manual test matrix results.
- Community Plugin-ready README.
- Release workflow.
- Browser deployment workflow if desired.
- Dependency and licence review.

Acceptance:

- `npm run check` and the separate `npm run check:web` pass.
- Release contains only plugin assets.
- README clearly states TURN limitations.
- README does not overstate PIN security.
- The implemented connection path uses the eight-digit Pitch number and sender approval.
- Relay configuration is documented.

---

## 17. Definition of done for the initial release

The initial release is done when:

- A user can select files in Obsidian and receive an eight-digit Pitch number.
- A browser or another Obsidian instance can enter the number.
- The sender must explicitly Accept or Deny.
- The receiver sees no file metadata before acceptance.
- The accepted receiver can choose a file from the manifest.
- The file transfers directly through the established WebRTC connection.
- The receiver verifies size and hash before treating the file as complete.
- Closing the sender UI ends the session.
- Nostr relay URLs can be edited in the Obsidian settings and browser client.
- Sender and receiver need at least one usable relay in common.
- Direct-connect failure is reported clearly.
- No server-side file storage, TURN service, account, pairing, or transfer history exists.
- The repository is shaped as a normal Obsidian plugin.
- `test/web` functions as a real interoperability client without becoming a separate package workspace.
- Plugin release assets do not contain the browser application.
- Automated tests cover admission, state transitions, integrity, cancellation, and cleanup.
- Documentation describes security and network limitations accurately.

---

## 18. Design principle

When implementation choices are unclear, return to this sentence:

> **Barrow Alley sets up a temporary pitch for selected files, admits one sender-approved receiver, and lets that receiver choose what to take.**

Anything that turns Barrow Alley into synchronisation, storage, persistent pairing, or a general transfer platform is outside the initial design.
