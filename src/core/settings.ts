/** Relay configuration persisted by each Barrow Alley host. */
export interface RelaySettings {
    /** Complete effective list used by newly created sessions. */
    readonly relays: readonly string[];
}
