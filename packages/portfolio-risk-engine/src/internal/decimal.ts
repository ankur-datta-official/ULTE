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

function normalized(value: ExactDecimal): ExactDecimal {
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
  return normalized({
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
  const result = normalized(value);
  const negative = result.coefficient < 0n;
  const digits = (negative ? -result.coefficient : result.coefficient).toString();
  if (result.scale === 0) return decimalString(`${negative ? "-" : ""}${digits}`);
  const padded = digits.padStart(result.scale + 1, "0");
  const split = padded.length - result.scale;
  return decimalString(`${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`);
}

export function compare(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function add(left: DecimalString, right: DecimalString): NonNegativeDecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return nonNegativeDecimalString(format({ coefficient: leftCoefficient + rightCoefficient, scale }));
}

export function subtractNonNegative(left: DecimalString, right: DecimalString): NonNegativeDecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return nonNegativeDecimalString(format({ coefficient: leftCoefficient - rightCoefficient, scale }));
}

export function limitAmount(equity: PositiveDecimalString, bps: number): NonNegativeDecimalString {
  const value = parse(equity);
  return nonNegativeDecimalString(format({
    coefficient: value.coefficient * BigInt(bps),
    scale: value.scale + 4,
  }));
}

export function amountWithinBpsLimit(
  amount: NonNegativeDecimalString,
  equity: PositiveDecimalString,
  bps: number,
): boolean {
  const amountValue = parse(amount);
  const equityValue = parse(equity);
  const [amountCoefficient, equityCoefficient] = align(amountValue, equityValue);
  return amountCoefficient * 10_000n <= equityCoefficient * BigInt(bps);
}

export function ratioAtOrAboveBps(
  numerator: NonNegativeDecimalString,
  denominator: PositiveDecimalString,
  bps: number,
): boolean {
  const numeratorValue = parse(numerator);
  const denominatorValue = parse(denominator);
  const [numeratorCoefficient, denominatorCoefficient] = align(numeratorValue, denominatorValue);
  return numeratorCoefficient * 10_000n >= denominatorCoefficient * BigInt(bps);
}

export function minimum(values: readonly NonNegativeDecimalString[]): NonNegativeDecimalString {
  let result = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index]!, result) < 0) result = values[index]!;
  }
  return result;
}

export function positive(value: unknown): PositiveDecimalString {
  return positiveDecimalString(value);
}

export function nonNegative(value: unknown): NonNegativeDecimalString {
  return nonNegativeDecimalString(value);
}

export const ZERO = nonNegativeDecimalString("0");
