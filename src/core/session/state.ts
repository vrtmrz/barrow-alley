export type SenderState =
  | "idle"
  | "preparing"
  | "waiting-for-peer"
  | "approval-pending"
  | "connected"
  | "serving"
  | "transferring"
  | "failed"
  | "closing"
  | "closed";

export type ReceiverState =
  | "idle"
  | "connecting"
  | "awaiting-approval"
  | "denied"
  | "loading-manifest"
  | "browsing"
  | "receiving"
  | "failed"
  | "closing"
  | "closed";

// These tables are the executable lifecycle policy. UI adapters may display the
// state, but must not infer or bypass transitions with their own booleans.
// In particular, `closed` has no outbound transition and is therefore terminal.
const SENDER_TRANSITIONS: Readonly<Record<SenderState, readonly SenderState[]>> = {
  idle: ["preparing", "closing", "failed"],
  preparing: ["waiting-for-peer", "closing", "failed"],
  "waiting-for-peer": ["approval-pending", "closing", "failed"],
  "approval-pending": ["waiting-for-peer", "connected", "closing", "failed"],
  connected: ["serving", "closing", "failed"],
  serving: ["transferring", "closing", "failed"],
  transferring: ["serving", "closing", "failed"],
  failed: ["closing"],
  closing: ["closed"],
  closed: [],
};

const RECEIVER_TRANSITIONS: Readonly<Record<ReceiverState, readonly ReceiverState[]>> = {
  idle: ["connecting", "closing", "failed"],
  connecting: ["awaiting-approval", "closing", "failed"],
  "awaiting-approval": ["denied", "loading-manifest", "closing", "failed"],
  denied: ["closing"],
  "loading-manifest": ["browsing", "closing", "failed"],
  browsing: ["receiving", "closing", "failed"],
  receiving: ["browsing", "closing", "failed"],
  failed: ["closing"],
  closing: ["closed"],
  closed: [],
};

export class SessionStateError extends Error {
  constructor(role: "sender" | "receiver", current: string, next: string) {
    super(`Invalid ${role} state transition: ${current} -> ${next}.`);
    this.name = "SessionStateError";
  }
}

export function transitionSenderState(current: SenderState, next: SenderState): SenderState {
  if (!SENDER_TRANSITIONS[current].includes(next)) {
    throw new SessionStateError("sender", current, next);
  }
  return next;
}

export function transitionReceiverState(current: ReceiverState, next: ReceiverState): ReceiverState {
  if (!RECEIVER_TRANSITIONS[current].includes(next)) {
    throw new SessionStateError("receiver", current, next);
  }
  return next;
}
