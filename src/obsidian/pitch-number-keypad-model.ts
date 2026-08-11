const PITCH_NUMBER_LENGTH = 8;

/** Read-only state rendered by the on-screen Pitch-number keypad. */
export interface PitchNumberKeypadSnapshot {
    /** Canonical ASCII digits entered so far, without visual grouping. */
    readonly value: string;
    /** Eight visible positions grouped in the same way as a Pitch number. */
    readonly display: string;
    /** Whether the value can be submitted to the receiver flow. */
    readonly complete: boolean;
}

/**
 * Holds partial Pitch-number entry without relying on an HTML input element.
 *
 * The Obsidian adapter renders this state as buttons so tapping digits on a
 * phone does not summon the operating system's software keyboard.
 */
export class PitchNumberKeypadModel {
    #value = "";

    get snapshot(): PitchNumberKeypadSnapshot {
        return {
            value: this.#value,
            display: formatPartialPitchNumber(this.#value),
            complete: this.#value.length === PITCH_NUMBER_LENGTH,
        };
    }

    /** Appends one ASCII decimal digit unless all eight positions are filled. */
    append(digit: string): void {
        if (!/^[0-9]$/u.test(digit) || this.#value.length >= PITCH_NUMBER_LENGTH) {
            return;
        }
        this.#value += digit;
    }

    /** Removes the most recently entered digit. */
    deleteLast(): void {
        this.#value = this.#value.slice(0, -1);
    }

    /** Removes every entered digit. */
    clear(): void {
        this.#value = "";
    }
}

function formatPartialPitchNumber(value: string): string {
    const positions = value.padEnd(PITCH_NUMBER_LENGTH, "_");
    return `${positions.slice(0, 4)} ${positions.slice(4)}`;
}
