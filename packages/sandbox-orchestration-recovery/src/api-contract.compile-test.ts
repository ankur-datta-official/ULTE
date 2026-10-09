import type { RecoveryBootAuthorityRef, RecoveryBootClassifierInput, RecoveryBootResult } from "./types.js";
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
type TerminalRequired = Extract<RecoveryBootResult, { readonly status: "TERMINAL_NON_SUBMISSION_REQUIRED" }>;
type Terminal = Extract<RecoveryBootResult, { readonly status: "TERMINAL_NON_SUBMISSION" }>;
type _ReadyNoReconciliation = Assert<HasNoField<Ready, "idempotency">>;
type _OutcomeKeyRequired = Assert<IsRequired<Outcome, "outcomeKey">>;
type _ReconcilePendingRequired = Assert<IsRequired<Reconcile, "pendingEffect">>;
type _ReconcileIdempotencyRequired = Assert<IsRequired<Reconcile, "idempotency">>;
type _RejectedNoAction = Assert<HasNoField<Rejected, "creationRef">>;
type _NoDatabaseExecutor = Assert<HasNoField<RecoveryBootClassifierInput, "executor">>;
type _NoProvider = Assert<HasNoField<RecoveryBootClassifierInput, "provider">>;
type _TerminalRequiredPending = Assert<IsRequired<TerminalRequired, "pendingEffect">>;
type _TerminalReceipt = Assert<IsRequired<Terminal, "dispositionReceipt">>;
type _TerminalNoExecution = Assert<HasNoField<Terminal, "executionAttempt">>;
type _TerminalNoRetry = Assert<HasNoField<Terminal, "retryAuthorized">>;
type _TerminalRequiredNoRetry = Assert<HasNoField<TerminalRequired, "retryAuthorized">>;
type _TerminalRequiredNoReceipt = Assert<HasNoField<TerminalRequired, "dispositionReceipt">>;
type _TerminalNoHydration = Assert<HasNoField<Terminal, "hydration">>;
void (null as unknown as [_ReadyNoReconciliation, _OutcomeKeyRequired, _ReconcilePendingRequired,
  _ReconcileIdempotencyRequired, _RejectedNoAction, _NoDatabaseExecutor, _NoProvider,
  _TerminalRequiredPending, _TerminalReceipt, _TerminalNoExecution, _TerminalNoRetry,
  _TerminalRequiredNoRetry, _TerminalRequiredNoReceipt, _TerminalNoHydration]);

// Compile-only compatibility examples; these do not fake a loader or invoke new classifier branches.
declare const authorityRef: RecoveryBootAuthorityRef;
declare const unresolvedPending: TerminalRequired["pendingEffect"];
declare const failedNotSubmitted: TerminalRequired["idempotency"];
declare const creationRef: TerminalRequired["creationRef"];
declare const terminalProof: TerminalRequired["proof"];
declare const terminalReceipt: Terminal["dispositionReceipt"];
declare const checkpointRef: Terminal["checkpointRef"];
const requiredResult: RecoveryBootResult = { ...authorityRef, status: "TERMINAL_NON_SUBMISSION_REQUIRED",
  checkpointRef, pendingEffect: unresolvedPending, creationRef, idempotency: failedNotSubmitted, proof: terminalProof };
const terminalResult: RecoveryBootResult = { ...authorityRef, status: "TERMINAL_NON_SUBMISSION",
  checkpointRef,
  dispositionRef: terminalReceipt.disposition.dispositionRef, dispositionReceipt: terminalReceipt,
  resolvedPendingEffectIdentity: terminalReceipt.disposition.pendingEffectIdentity,
  sessionDisposition: "TERMINAL_NON_SUBMISSION" };
// @ts-expect-error Terminal results do not grant retry authority.
terminalResult.retryAuthorized;
// @ts-expect-error Work-required results are blocked, not READY.
const readyFromRequired: Extract<RecoveryBootResult, { readonly status: "READY" }> = requiredResult;
void terminalResult; void readyFromRequired;

function exhaustive(value: RecoveryBootResult): string {
  switch (value.status) {
    case "READY": return value.status;
    case "INTENT_DISPOSITION_REQUIRED": return value.status;
    case "CANONICAL_OUTCOME_REQUIRED": return value.status;
    case "OUTCOME_AVAILABLE": return value.outcomeKey;
    case "RECONCILIATION_REQUIRED": return value.status;
    case "TERMINAL_NON_SUBMISSION_REQUIRED": return value.pendingEffect.idempotencyKey;
    case "TERMINAL_NON_SUBMISSION": return value.dispositionRef;
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
