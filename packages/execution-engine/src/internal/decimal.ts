import {
  nonNegativeDecimalString,
  type DecimalString,
  type NonNegativeDecimalString,
} from "@ulte/instrument-model";

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parse(value: DecimalString): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  return {
    coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`),
    scale: fraction.length,
  };
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function format(coefficient: bigint, scale: number): NonNegativeDecimalString {
  if (coefficient < 0n) throw new RangeError("A non-negative decimal result was required");
  if (coefficient === 0n) return nonNegativeDecimalString("0");
  let digits = coefficient.toString();
  if (scale === 0) return nonNegativeDecimalString(digits);
  digits = digits.padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return nonNegativeDecimalString(fraction.length === 0 ? whole : `${whole}.${fraction}`);
}

export function compareDecimal(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function addNonNegative(
  left: NonNegativeDecimalString,
  right: NonNegativeDecimalString,
): NonNegativeDecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  return format(leftCoefficient + rightCoefficient, scale);
}

export function subtractNonNegative(
  left: NonNegativeDecimalString,
  right: NonNegativeDecimalString,
): NonNegativeDecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parse(left), parse(right));
  if (rightCoefficient > leftCoefficient) throw new RangeError("Decimal subtraction would be negative");
  return format(leftCoefficient - rightCoefficient, scale);
}
