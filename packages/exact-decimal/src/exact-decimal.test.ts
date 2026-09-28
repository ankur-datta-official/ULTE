import { describe, expect, it } from "vitest";
import { decimalString, nonNegativeDecimalString } from "@ulte/instrument-model";
import {
  addDecimal,
  compareDecimal,
  multiplyDecimal,
  subtractDecimal,
  subtractNonNegative,
} from "./index.js";

const d = decimalString;
const n = nonNegativeDecimalString;

describe("exact decimal arithmetic", () => {
  it("compares equivalent mixed scales", () => {
    expect(compareDecimal(d("1"), d("1.0"))).toBe(0);
    expect(compareDecimal(d("1.0"), d("1.00"))).toBe(0);
  });

  it.each([
    ["1.25", "2.5", "3.75"],
    ["-1.25", "2.5", "1.25"],
    ["-1.5", "0.5", "-1"],
  ])("adds %s and %s exactly", (left, right, expected) => {
    expect(addDecimal(d(left), d(right))).toBe(expected);
  });

  it.each([
    ["10", "5.75", "4.25"],
    ["1", "2", "-1"],
    ["0.3", "0.2", "0.1"],
  ])("subtracts %s and %s exactly", (left, right, expected) => {
    expect(subtractDecimal(d(left), d(right))).toBe(expected);
  });

  it("rejects a negative non-negative subtraction", () => {
    expect(() => subtractNonNegative(n("1"), n("2"))).toThrow(RangeError);
  });

  it.each([
    ["1.25", "2.4", "3"],
    ["-1.5", "2", "-3"],
    ["0.1", "0.2", "0.02"],
  ])("multiplies %s and %s exactly", (left, right, expected) => {
    expect(multiplyDecimal(d(left), d(right))).toBe(expected);
  });

  it("canonicalizes zero and removes trailing fractional zeros", () => {
    expect(addDecimal(d("-1.2500"), d("1.25"))).toBe("0");
    expect(addDecimal(d("1.2500"), d("2.5"))).toBe("3.75");
  });
});
