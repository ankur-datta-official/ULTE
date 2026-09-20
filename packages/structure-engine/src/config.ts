export interface StructureConfig {
  readonly lookbackBars: number;
  readonly pivotLeftBars: number;
  readonly pivotRightBars: number;
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function createStructureConfig(input: StructureConfig): Readonly<StructureConfig> {
  positiveSafeInteger(input.lookbackBars, "lookbackBars");
  positiveSafeInteger(input.pivotLeftBars, "pivotLeftBars");
  positiveSafeInteger(input.pivotRightBars, "pivotRightBars");
  if (input.pivotLeftBars > Number.MAX_SAFE_INTEGER - input.pivotRightBars - 1) {
    throw new RangeError("Pivot window exceeds safe integer range");
  }
  const minimum = input.pivotLeftBars + input.pivotRightBars + 1;
  if (input.lookbackBars < minimum) {
    throw new RangeError(`lookbackBars must be at least ${minimum} for the configured pivot window`);
  }
  return Object.freeze({ ...input });
}
