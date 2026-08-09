import { describe, expect, it } from "vitest";

import type { ProtocolMessage } from "../../src/core/protocol/messages.js";
import { sendFile } from "../../src/core/transfer/sender.js";
import type { Source } from "../../src/core/index.js";

const hash = "74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0";
const bytes = Uint8Array.of(1, 2, 3, 4, 5);

describe("file sender", () => {
    it("awaits each bounded frame before offering the next one", async () => {
        const messages: ProtocolMessage[] = [];
        const progress: number[] = [];
        let sendsInFlight = 0;
        let maximumSendsInFlight = 0;
        const source: Source = {
            list: async () => [],
            open: async () => bytes.slice(),
        };

        await sendFile({
            sessionId: "session-1",
            fileId: "item-1",
            source,
            sourceItem: { id: "source-1", displayName: "data.bin", size: 5, hash },
            manifestItem: { id: "item-1", displayName: "data.bin", size: 5, hash },
            chunkSize: 2,
            onProgress: ({ transferredBytes }) => progress.push(transferredBytes),
            send: async (message) => {
                sendsInFlight += 1;
                maximumSendsInFlight = Math.max(maximumSendsInFlight, sendsInFlight);
                await Promise.resolve();
                messages.push(message);
                sendsInFlight -= 1;
            },
        });

        expect(maximumSendsInFlight).toBe(1);
        expect(messages.map(({ type }) => type)).toEqual([
            "file-begin",
            "file-chunk",
            "file-chunk",
            "file-chunk",
            "file-end",
        ]);
        expect(
            messages.flatMap((message) =>
                message.type === "file-chunk" ? [message.data.byteLength] : []
            ),
        ).toEqual([2, 2, 1]);
        expect(progress).toEqual([0, 2, 4, 5]);
    });
});
