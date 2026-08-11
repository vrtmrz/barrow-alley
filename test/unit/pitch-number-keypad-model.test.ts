import { describe, expect, it } from "vitest";

import { PitchNumberKeypadModel } from "../../src/obsidian/pitch-number-keypad-model.js";

describe("PitchNumberKeypadModel", () => {
    it("builds and groups an eight-digit Pitch number", () => {
        const model = new PitchNumberKeypadModel();

        expect(model.snapshot).toEqual({
            value: "",
            display: "____ ____",
            complete: false,
        });
        for (const digit of "12345678") model.append(digit);

        expect(model.snapshot).toEqual({
            value: "12345678",
            display: "1234 5678",
            complete: true,
        });
    });

    it("ignores non-digits and input beyond the eighth position", () => {
        const model = new PitchNumberKeypadModel();

        for (const digit of "123456789") model.append(digit);
        model.append("x");

        expect(model.snapshot.value).toBe("12345678");
    });

    it("supports deleting the last digit and clearing all digits", () => {
        const model = new PitchNumberKeypadModel();
        for (const digit of "1203") model.append(digit);

        model.deleteLast();
        expect(model.snapshot.display).toBe("120_ ____");
        model.clear();
        expect(model.snapshot.value).toBe("");
    });
});
