interface DecimalParts { readonly coefficient: bigint; readonly scale: number }

function parts(value: string): DecimalParts {
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function compareDecimalStrings(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  const ac = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bc = b.coefficient * 10n ** BigInt(scale - b.scale);
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}
