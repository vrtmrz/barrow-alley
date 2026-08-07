import { describe, expect, it } from "vitest";

import {
  derivePitchCredentials,
  formatPitchNumber,
  generatePitchNumber,
  PitchNumberError,
  validatePitchNumber,
  type RandomByteFiller,
} from "../../src/core/pitch-number.js";

describe("Pitch number", () => {
  it("generates exactly eight unbiased decimal digits from an injected secure boundary", () => {
    const values = [250, 255, 0, 1, 9, 10, 19, 20, 29, 249];
    let offset = 0;
    const fill: RandomByteFiller = (target) => {
      for (let index = 0; index < target.length; index += 1) {
        target[index] = values[offset] ?? 0;
        offset += 1;
      }
    };

    expect(generatePitchNumber(fill)).toBe("01909099");
  });

  it("formats and validates plain or grouped input", () => {
    expect(formatPitchNumber("12345678")).toBe("1234 5678");
    expect(validatePitchNumber(" 1234 5678 ")).toBe("12345678");
    expect(validatePitchNumber("12345678")).toBe("12345678");
  });

  it.each(["", "1234567", "123456789", "1234-5678", "abcdefgh", "１２３４５６７８"])(
    "rejects invalid input %j",
    (input) => {
      expect(() => validatePitchNumber(input)).toThrowError(PitchNumberError);
    },
  );

  it("derives stable, domain-separated Trystero inputs without exposing the number", async () => {
    const first = await derivePitchCredentials("1234 5678");
    const second = await derivePitchCredentials("12345678");

    expect(first).toEqual(second);
    expect(first.roomId).not.toBe(first.password);
    expect(first.roomId).not.toContain("12345678");
    expect(first.password).not.toContain("12345678");
    expect(first.roomId).toMatch(/^barrow-alley-[0-9a-f]{64}$/u);
    expect(first.password).toMatch(/^[0-9a-f]{64}$/u);
  });
});
