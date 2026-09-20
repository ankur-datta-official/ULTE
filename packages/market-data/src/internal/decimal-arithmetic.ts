import {
  nonNegativeDecimalString,
  type DecimalString,
  type NonNegativeDecimalString,
} from "@ulte/instrument-model";

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parts(value: DecimalString): DecimalParts {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function atScale(value: DecimalParts, scale: number): bigint {
  return value.coefficient * powerOfTen(scale - value.scale);
}

function plainDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return "0";

  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  }
  return `${negative ? "-" : ""}${digits}`;
}

export function addNonNegativeDecimals(
  left: NonNegativeDecimalString,
  right: NonNegativeDecimalString,
): NonNegativeDecimalString {
  const leftParts = parts(left);
  const rightParts = parts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return nonNegativeDecimalString(plainDecimal(atScale(leftParts, scale) + atScale(rightParts, scale), scale));
}

export function compareDecimals(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const leftParts = parts(left);
  const rightParts = parts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = atScale(leftParts, scale);
  const rightCoefficient = atScale(rightParts, scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}
