import type { DecimalString } from "@ulte/instrument-model";

interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseExact(value: DecimalString): ExactDecimal {
  const [whole = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function compareDecimalStrings(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const a = parseExact(left);
  const b = parseExact(right);
  const scale = Math.max(a.scale, b.scale);
  const alignedA = a.coefficient * 10n ** BigInt(scale - a.scale);
  const alignedB = b.coefficient * 10n ** BigInt(scale - b.scale);
  return alignedA < alignedB ? -1 : alignedA > alignedB ? 1 : 0;
}
