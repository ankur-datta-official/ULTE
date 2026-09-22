export const BROKER_FAILURE_CATEGORIES = [
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
  "INVALID_REQUEST",
  "INSUFFICIENT_FUNDS",
  "INSTRUMENT_UNAVAILABLE",
  "MARKET_UNAVAILABLE",
  "ORDER_REJECTED",
  "IDEMPOTENCY_CONFLICT",
  "ADAPTER_UNAVAILABLE",
  "UNKNOWN",
] as const;
export type BrokerFailureCategory = (typeof BROKER_FAILURE_CATEGORIES)[number];

export const OUTCOME_CERTAINTIES = ["DEFINITE_FAILURE", "OUTCOME_UNKNOWN"] as const;
export type OutcomeCertainty = (typeof OUTCOME_CERTAINTIES)[number];

export const SUBMISSION_EXPOSURES = ["NOT_SUBMITTED", "MAY_HAVE_BEEN_SUBMITTED"] as const;
export type SubmissionExposure = (typeof SUBMISSION_EXPOSURES)[number];

export type RetryDisposition = "DO_NOT_RETRY" | "RETRY_SAFE" | "REQUIRES_RECONCILIATION";

export interface BrokerFailure {
  readonly category: BrokerFailureCategory;
  readonly certainty: OutcomeCertainty;
  readonly submissionExposure: SubmissionExposure;
  readonly adapterReasonCode?: string;
  readonly sanitizedMessage?: string;
}

export interface BrokerFailureInput extends BrokerFailure {}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

export function createBrokerFailure(input: BrokerFailureInput): BrokerFailure {
  if (!(BROKER_FAILURE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new TypeError("Invalid broker failure category");
  }
  if (!(OUTCOME_CERTAINTIES as readonly string[]).includes(input.certainty)) {
    throw new TypeError("Invalid outcome certainty");
  }
  if (!(SUBMISSION_EXPOSURES as readonly string[]).includes(input.submissionExposure)) {
    throw new TypeError("Invalid submission exposure");
  }
  if (input.certainty === "OUTCOME_UNKNOWN" && input.submissionExposure !== "MAY_HAVE_BEEN_SUBMITTED") {
    throw new TypeError("An unknown outcome must acknowledge possible submission");
  }
  return Object.freeze({
    category: input.category,
    certainty: input.certainty,
    submissionExposure: input.submissionExposure,
    ...(input.adapterReasonCode === undefined
      ? {}
      : { adapterReasonCode: nonEmpty(input.adapterReasonCode, "adapterReasonCode") }),
    ...(input.sanitizedMessage === undefined
      ? {}
      : { sanitizedMessage: nonEmpty(input.sanitizedMessage, "sanitizedMessage") }),
  });
}

const DO_NOT_RETRY_CATEGORIES: readonly BrokerFailureCategory[] = Object.freeze([
  "AUTHENTICATION",
  "AUTHORIZATION",
  "INVALID_REQUEST",
  "INSUFFICIENT_FUNDS",
  "ORDER_REJECTED",
  "IDEMPOTENCY_CONFLICT",
]);

const TRANSIENT_CATEGORIES: readonly BrokerFailureCategory[] = Object.freeze([
  "RATE_LIMIT",
  "NETWORK",
  "TIMEOUT",
  "ADAPTER_UNAVAILABLE",
]);

export function classifyRetryDisposition(failure: BrokerFailure): RetryDisposition {
  if (failure.certainty === "OUTCOME_UNKNOWN" || failure.submissionExposure === "MAY_HAVE_BEEN_SUBMITTED") {
    return "REQUIRES_RECONCILIATION";
  }
  if (DO_NOT_RETRY_CATEGORIES.includes(failure.category)) return "DO_NOT_RETRY";
  if (TRANSIENT_CATEGORIES.includes(failure.category)) return "RETRY_SAFE";
  return "DO_NOT_RETRY";
}
