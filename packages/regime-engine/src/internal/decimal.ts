import type { DecimalString } from "@ulte/instrument-model";

export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseExact(value: DecimalString): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

export function add(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [a, b, scale] = align(left, right);
  return { coefficient: a + b, scale };
}

export function subtract(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [a, b, scale] = align(left, right);
  return { coefficient: a - b, scale };
}

export function absolute(value: ExactDecimal): ExactDecimal {
  return { coefficient: value.coefficient < 0n ? -value.coefficient : value.coefficient, scale: value.scale };
}

export function compare(left: ExactDecimal, right: ExactDecimal): -1 | 0 | 1 {
  const [a, b] = align(left, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maximum(...values: readonly ExactDecimal[]): ExactDecimal {
  let result = values[0]!;
  for (const value of values.slice(1)) if (compare(value, result) > 0) result = value;
  return result;
}

export function scaledRatioFloor(numerator: ExactDecimal, denominator: ExactDecimal, scale: bigint): bigint {
  if (denominator.coefficient <= 0n || numerator.coefficient < 0n) throw new RangeError("Ratio operands are invalid");
  const adjustedNumerator = numerator.coefficient * powerOfTen(denominator.scale) * scale;
  const adjustedDenominator = denominator.coefficient * powerOfTen(numerator.scale);
  return adjustedNumerator / adjustedDenominator;
}

export function compareRatioToBps(
  numerator: ExactDecimal,
  numeratorCount: number,
  denominator: ExactDecimal,
  denominatorCount: number,
  thresholdBps: number,
): -1 | 0 | 1 {
  const [n, d] = align(numerator, denominator);
  const left = n * BigInt(denominatorCount) * 10_000n;
  const right = d * BigInt(numeratorCount) * BigInt(thresholdBps);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function meanRatioBpsFloor(
  numerator: ExactDecimal,
  numeratorCount: number,
  denominator: ExactDecimal,
  denominatorCount: number,
): bigint {
  const [n, d] = align(numerator, denominator);
  return (n * BigInt(denominatorCount) * 10_000n) / (d * BigInt(numeratorCount));
}
