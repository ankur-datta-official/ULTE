import {
  decimalString,
  nonNegativeDecimalString,
  type DecimalString,
  type NonNegativeDecimalString,
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
  const validated = decimalString(value);
  const negative = validated.startsWith("-");
  const unsigned = negative ? validated.slice(1) : validated;
  const [whole, fraction = ""] = unsigned.split(".");
  return normalize({
    coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
    scale: fraction.length,
  });
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

function format(coefficient: bigint, scale: number): DecimalString {
  const normalized = normalize({ coefficient, scale });
  if (normalized.coefficient === 0n) return decimalString("0");
  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return decimalString(`${negative ? "-" : ""}${digits}`);
  const padded = digits.padStart(normalized.scale + 1, "0");
  const split = padded.length - normalized.scale;
  return decimalString(`${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}`);
}

export function compareDecimal(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function addDecimal(left: DecimalString, right: DecimalString): DecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return format(leftCoefficient + rightCoefficient, scale);
}

export function subtractDecimal(left: DecimalString, right: DecimalString): DecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return format(leftCoefficient - rightCoefficient, scale);
}

export function subtractNonNegative(
  left: NonNegativeDecimalString,
  right: NonNegativeDecimalString,
): NonNegativeDecimalString {
  const result = subtractDecimal(left, right);
  if (result.startsWith("-")) throw new RangeError("Decimal subtraction would be negative");
  return nonNegativeDecimalString(result);
}

export function multiplyDecimal(left: DecimalString, right: DecimalString): DecimalString {
  const leftValue = parse(left);
  const rightValue = parse(right);
  return format(
    leftValue.coefficient * rightValue.coefficient,
    leftValue.scale + rightValue.scale,
  );
}
