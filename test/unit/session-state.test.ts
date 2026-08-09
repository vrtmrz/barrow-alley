import { describe, expect, it } from "vitest";

import {
    SessionStateError,
    transitionReceiverState,
    transitionSenderState,
} from "../../src/core/index.js";

describe("session state transitions", () => {
    it("allows the sender accept and deny paths", () => {
        expect(transitionSenderState("idle", "preparing")).toBe("preparing");
        expect(transitionSenderState("approval-pending", "waiting-for-peer")).toBe(
            "waiting-for-peer",
        );
        expect(transitionSenderState("approval-pending", "connected")).toBe("connected");
        expect(transitionSenderState("transferring", "serving")).toBe("serving");
    });

    it("allows the receiver admission and retrieval paths", () => {
        expect(transitionReceiverState("awaiting-approval", "denied")).toBe("denied");
        expect(transitionReceiverState("awaiting-approval", "loading-manifest")).toBe(
            "loading-manifest",
        );
        expect(transitionReceiverState("receiving", "browsing")).toBe("browsing");
    });

    it("keeps closed terminal and rejects skipped states", () => {
        expect(() => transitionSenderState("closed", "waiting-for-peer")).toThrowError(
            SessionStateError,
        );
        expect(() => transitionReceiverState("idle", "browsing")).toThrowError(SessionStateError);
    });
});
