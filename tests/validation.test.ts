import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../src/shared/validation.js";

describe("parsePositiveInteger", () => {
  it.each(["1", "20", "1000"])("accepts positive integer %s", (value) => {
    expect(parsePositiveInteger(value)).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "abc", "Infinity", "9007199254740992"])(
    "rejects invalid limit %s",
    (value) => {
      expect(() => parsePositiveInteger(value)).toThrow("Expected a positive integer");
    },
  );
});
