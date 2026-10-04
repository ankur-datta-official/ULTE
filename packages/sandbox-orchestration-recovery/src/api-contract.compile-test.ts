import type { RecoveryBootClassifierInput, RecoveryBootResult } from "./types.js";
import { classifyRecoveryBoot } from "./classify.js";

type Assert<T extends true> = T;
type HasNoField<T, K extends PropertyKey> = K extends keyof T ? false : true;
type IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;

declare const input: RecoveryBootClassifierInput;
declare const result: RecoveryBootResult;
const classify: (facts: RecoveryBootClassifierInput) => RecoveryBootResult = classifyRecoveryBoot;
void classify;
void input;

type Ready = Extract<RecoveryBootResult, { readonly status: "READY" }>;
type Outcome = Extract<RecoveryBootResult, { readonly status: "OUTCOME_AVAILABLE" }>;
type Reconcile = Extract<RecoveryBootResult, { readonly status: "RECONCILIATION_REQUIRED" }>;
type Rejected = Extract<RecoveryBootResult, { readonly status: "RECOVERY_REJECTED" }>;
type _ReadyNoReconciliation = Assert<HasNoField<Ready, "idempotency">>;
type _OutcomeKeyRequired = Assert<IsRequired<Outcome, "outcomeKey">>;
type _ReconcilePendingRequired = Assert<IsRequired<Reconcile, "pendingEffect">>;
type _ReconcileIdempotencyRequired = Assert<IsRequired<Reconcile, "idempotency">>;
type _RejectedNoAction = Assert<HasNoField<Rejected, "creationRef">>;
type _NoDatabaseExecutor = Assert<HasNoField<RecoveryBootClassifierInput, "executor">>;
type _NoProvider = Assert<HasNoField<RecoveryBootClassifierInput, "provider">>;
void (null as unknown as [_ReadyNoReconciliation, _OutcomeKeyRequired, _ReconcilePendingRequired,
  _ReconcileIdempotencyRequired, _RejectedNoAction, _NoDatabaseExecutor, _NoProvider]);

function exhaustive(value: RecoveryBootResult): string {
  switch (value.status) {
    case "READY": return value.status;
    case "INTENT_DISPOSITION_REQUIRED": return value.status;
    case "CANONICAL_OUTCOME_REQUIRED": return value.status;
    case "OUTCOME_AVAILABLE": return value.outcomeKey;
    case "RECONCILIATION_REQUIRED": return value.status;
    case "RECOVERY_REJECTED": return value.reason;
    default: {
      const neverValue: never = value;
      return neverValue;
    }
  }
}
void exhaustive;

// @ts-expect-error A canonical outcome identity is mandatory.
const missingOutcome: Outcome = { status: "OUTCOME_AVAILABLE" };
void missingOutcome;
// @ts-expect-error Reconciliation cannot be represented without pending and idempotency evidence.
const missingReconciliation: Reconcile = { status: "RECONCILIATION_REQUIRED" };
void missingReconciliation;
