declare const unixMsBrand: unique symbol;
declare const timeframeIdBrand: unique symbol;

export type UnixMs = number & { readonly [unixMsBrand]: "UnixMs" };
export type TimeframeId = string & { readonly [timeframeIdBrand]: "TimeframeId" };
export type TimeframeUnit = "s" | "m" | "h" | "d" | "w";

const TIMEFRAME_PATTERN = /^([1-9]\d*)([smhdw])$/;
const UNIT_MILLISECONDS: Readonly<Record<TimeframeUnit, bigint>> = Object.freeze({
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
  d: 86_400_000n,
  w: 604_800_000n,
});

export function unixMs(value: unknown): UnixMs {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid Unix epoch milliseconds: ${String(value)}`);
  }
  return value as UnixMs;
}

export function parseTimeframe(value: unknown): TimeframeId {
  if (typeof value !== "string") {
    throw new TypeError("Timeframe must be a string");
  }
  const match = TIMEFRAME_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(`Invalid fixed-duration timeframe: ${value}`);
  }
  const amount = BigInt(match[1]!);
  const unit = match[2] as TimeframeUnit;
  const milliseconds = amount * UNIT_MILLISECONDS[unit];
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Timeframe duration is not a safe integer: ${value}`);
  }
  return value as TimeframeId;
}

export function formatTimeframe(timeframe: TimeframeId): string {
  return timeframe;
}

export function timeframeToMilliseconds(timeframe: TimeframeId): number {
  const validated = parseTimeframe(timeframe);
  const match = TIMEFRAME_PATTERN.exec(validated)!;
  return Number(BigInt(match[1]!) * UNIT_MILLISECONDS[match[2] as TimeframeUnit]);
}
