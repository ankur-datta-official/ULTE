import {
  decimalString,
  nonNegativeDecimalString,
  positiveDecimalString,
  type DecimalString,
  type NonNegativeDecimalString,
  type PositiveDecimalString,
} from "@ulte/instrument-model";

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function normalize(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function parse(value: DecimalString): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  return normalize({
    coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
    scale: fraction.length,
  });
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

function format(value: ExactDecimal): DecimalString {
  const normalized = normalize(value);
  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return decimalString(`${negative ? "-" : ""}${digits}`);
  const padded = digits.padStart(normalized.scale + 1, "0");
  const split = padded.length - normalized.scale;
  return decimalString(`${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`);
}

export function compare(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function multiply(left: DecimalString, right: DecimalString): PositiveDecimalString {
  const leftValue = parse(left);
  const rightValue = parse(right);
  return positiveDecimalString(format({
    coefficient: leftValue.coefficient * rightValue.coefficient,
    scale: leftValue.scale + rightValue.scale,
  }));
}

export function multiplyByInteger(value: PositiveDecimalString, multiplier: bigint): PositiveDecimalString {
  const parsed = parse(value);
  return positiveDecimalString(format({ coefficient: parsed.coefficient * multiplier, scale: parsed.scale }));
}

export function subtractNonNegative(
  left: PositiveDecimalString,
  right: PositiveDecimalString,
): NonNegativeDecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return nonNegativeDecimalString(format({ coefficient: leftCoefficient - rightCoefficient, scale }));
}

export function floorRatio(numerator: PositiveDecimalString, denominator: PositiveDecimalString): bigint {
  const [numeratorCoefficient, denominatorCoefficient] = align(parse(numerator), parse(denominator));
  return numeratorCoefficient / denominatorCoefficient;
}

export function exactIntegerRatio(numerator: PositiveDecimalString, denominator: PositiveDecimalString): bigint | undefined {
  const [numeratorCoefficient, denominatorCoefficient] = align(parse(numerator), parse(denominator));
  if (numeratorCoefficient % denominatorCoefficient !== 0n) return undefined;
  return numeratorCoefficient / denominatorCoefficient;
}

export function ratioBpsFloor(numerator: PositiveDecimalString, denominator: PositiveDecimalString): string {
  const [numeratorCoefficient, denominatorCoefficient] = align(parse(numerator), parse(denominator));
  return ((numeratorCoefficient * 10_000n) / denominatorCoefficient).toString();
}
