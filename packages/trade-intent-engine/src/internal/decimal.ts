import type { DecimalString } from "@ulte/instrument-model";

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

export function compareDecimal(left: DecimalString, right: DecimalString): number {
  const leftValue = parse(left);
  const rightValue = parse(right);
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const leftCoefficient = leftValue.coefficient * 10n ** BigInt(scale - leftValue.scale);
  const rightCoefficient = rightValue.coefficient * 10n ** BigInt(scale - rightValue.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}
