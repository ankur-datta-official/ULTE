import { decimalString, nonNegativeDecimalString, positiveDecimalString, type DecimalString, type NonNegativeDecimalString, type PositiveDecimalString } from "@ulte/instrument-model";

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

export function parseExact(value: DecimalString): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);
  return normalized({ coefficient, scale: fraction.length });
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

export function compare(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parseExact(left), parseExact(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
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

export function add(left: DecimalString, right: DecimalString): DecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parseExact(left), parseExact(right));
  return format({ coefficient: leftCoefficient + rightCoefficient, scale });
}

export function subtract(left: DecimalString, right: DecimalString): DecimalString {
  const [leftCoefficient, rightCoefficient, scale] = align(parseExact(left), parseExact(right));
  return format({ coefficient: leftCoefficient - rightCoefficient, scale });
}

export function basisPointCost(price: PositiveDecimalString, bps: number): NonNegativeDecimalString {
  const value = parseExact(price);
  return nonNegativeDecimalString(format({ coefficient: value.coefficient * BigInt(bps), scale: value.scale + 4 }));
}

export function asPositive(value: DecimalString): PositiveDecimalString {
  return positiveDecimalString(value);
}

export function asNonNegative(value: DecimalString): NonNegativeDecimalString {
  return nonNegativeDecimalString(value);
}

export function ratioMeetsMinimum(
  reward: PositiveDecimalString, risk: PositiveDecimalString, minimumBps: number,
): boolean {
  const rewardValue = parseExact(reward);
  const riskValue = parseExact(risk);
  const scale = Math.max(rewardValue.scale, riskValue.scale);
  const rewardCoefficient = rewardValue.coefficient * powerOfTen(scale - rewardValue.scale);
  const riskCoefficient = riskValue.coefficient * powerOfTen(scale - riskValue.scale);
  return rewardCoefficient * 10_000n >= riskCoefficient * BigInt(minimumBps);
}

export function ratioBps(reward: PositiveDecimalString, risk: PositiveDecimalString): string {
  const rewardValue = parseExact(reward);
  const riskValue = parseExact(risk);
  const scale = Math.max(rewardValue.scale, riskValue.scale);
  const rewardCoefficient = rewardValue.coefficient * powerOfTen(scale - rewardValue.scale);
  const riskCoefficient = riskValue.coefficient * powerOfTen(scale - riskValue.scale);
  return ((rewardCoefficient * 10_000n) / riskCoefficient).toString();
}
