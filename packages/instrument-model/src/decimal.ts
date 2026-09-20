declare const decimalBrand: unique symbol;
declare const nonNegativeDecimalBrand: unique symbol;
declare const positiveDecimalBrand: unique symbol;

export type DecimalString = string & { readonly [decimalBrand]: "DecimalString" };
export type NonNegativeDecimalString = DecimalString & {
  readonly [nonNegativeDecimalBrand]: "NonNegativeDecimalString";
};
export type PositiveDecimalString = NonNegativeDecimalString & {
  readonly [positiveDecimalBrand]: "PositiveDecimalString";
};

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ZERO_PATTERN = /^0(?:\.0+)?$/;
const NEGATIVE_ZERO_PATTERN = /^-0(?:\.0+)?$/;

export function decimalString(value: unknown): DecimalString {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value) || NEGATIVE_ZERO_PATTERN.test(value)) {
    throw new TypeError(`Invalid canonical decimal string: ${String(value)}`);
  }
  return value as DecimalString;
}

export function nonNegativeDecimalString(value: unknown): NonNegativeDecimalString {
  const decimal = decimalString(value);
  if (decimal.startsWith("-")) {
    throw new RangeError(`Expected a non-negative decimal string: ${decimal}`);
  }
  return decimal as NonNegativeDecimalString;
}

export function positiveDecimalString(value: unknown): PositiveDecimalString {
  const decimal = nonNegativeDecimalString(value);
  if (ZERO_PATTERN.test(decimal)) {
    throw new RangeError(`Expected a positive decimal string: ${decimal}`);
  }
  return decimal as PositiveDecimalString;
}
