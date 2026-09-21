import type { DecimalString, PositiveDecimalString } from "@ulte/instrument-model";

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parse(value: DecimalString): ExactDecimal {
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function align(left: ExactDecimal, right: ExactDecimal): readonly [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
  ];
}

export function compareDecimal(left: DecimalString, right: DecimalString): number {
  const [leftCoefficient, rightCoefficient] = align(parse(left), parse(right));
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function isExactIntegerMultiple(value: PositiveDecimalString, step: PositiveDecimalString): boolean {
  const [valueCoefficient, stepCoefficient] = align(parse(value), parse(step));
  return valueCoefficient % stepCoefficient === 0n;
}

function absoluteDifference(left: PositiveDecimalString, right: PositiveDecimalString): readonly [bigint, number] {
  const leftValue = parse(left);
  const rightValue = parse(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftCoefficient = leftValue.coefficient * 10n ** BigInt(scale - leftValue.scale);
  const rightCoefficient = rightValue.coefficient * 10n ** BigInt(scale - rightValue.scale);
  const difference = leftCoefficient - rightCoefficient;
  return [difference < 0n ? -difference : difference, scale];
}

export function deviationExceedsBps(
  current: PositiveDecimalString,
  reference: PositiveDecimalString,
  maximumBps: number,
): boolean {
  const [difference, scale] = absoluteDifference(current, reference);
  const referenceValue = parse(reference);
  const referenceCoefficient = referenceValue.coefficient * 10n ** BigInt(scale - referenceValue.scale);
  return difference * 10_000n > referenceCoefficient * BigInt(maximumBps);
}

export function deviationBpsFloor(current: PositiveDecimalString, reference: PositiveDecimalString): string {
  const [difference, scale] = absoluteDifference(current, reference);
  const referenceValue = parse(reference);
  const referenceCoefficient = referenceValue.coefficient * 10n ** BigInt(scale - referenceValue.scale);
  return ((difference * 10_000n) / referenceCoefficient).toString();
}
