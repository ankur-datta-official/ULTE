function immutableCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("ReplayCollector values must contain only plain objects and arrays");
  }
  const copy: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = immutableCopy((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(copy) as T;
}

export class ReplayCollector<T> {
  private readonly collected: T[] = [];

  collect(value: T): void {
    this.collected.push(immutableCopy(value));
  }

  collectAll(values: readonly T[]): void {
    for (const value of values) this.collect(value);
  }

  snapshot(): readonly T[] {
    return Object.freeze([...this.collected]);
  }
}
