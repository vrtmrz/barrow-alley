import { describe, expect, it } from "vitest";

import { TextSource, TextSourceError } from "../../src/core/text-source.js";

describe("text source", () => {
    it("offers the entered text as one timestamped UTF-8 plain-text file", async () => {
        const text = "First line.\n二行目。\n";
        const source = new TextSource(
            text,
            new Date(2026, 7, 24, 10, 12, 34),
        );

        const items = await source.list();

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            id: "shared-text",
            displayName: "shared-20260824-101234.txt",
            size: new TextEncoder().encode(text).byteLength,
            mimeType: "text/plain",
            hash: "02db60a1e66e09ee7ed61d8f42b8b55dc38516ba1b11bcb3bf433879963d7b9d",
        });
        await expect(source.open("shared-text")).resolves.toEqual(
            new TextEncoder().encode(text),
        );
    });

    it("returns a fresh byte snapshot each time the text is opened", async () => {
        const source = new TextSource("Keep this intact.");
        const first = await source.open("shared-text");
        first.fill(0);

        await expect(source.open("shared-text")).resolves.toEqual(
            new TextEncoder().encode("Keep this intact."),
        );
    });

    it("rejects an empty entry and unknown source IDs", async () => {
        expect(() => new TextSource("")).toThrowError(
            new TextSourceError("EMPTY_TEXT", "Enter text to share."),
        );

        const source = new TextSource("Available text");
        await expect(source.open("another-item")).rejects.toEqual(
            new TextSourceError("UNKNOWN_ITEM", "The requested text is not available."),
        );
    });
});
