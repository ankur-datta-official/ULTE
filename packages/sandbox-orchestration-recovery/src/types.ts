import type { IdempotencyRecord } from "@ulte/broker-adapters";
import type {
  ExecutionAuthorityCheckpoint,
  ExecutionAuthorityCheckpointId,
  ExternalOutcomeAdoptionReceipt,
  OrchestrationExternalOutcome,
  OrchestrationFenceToken,
  OrchestrationLeaseOwnerId,
  OrchestrationOutcomeKey,
  OrchestrationPendingEffect,
  OrchestrationPendingEffectIdentity,
  OrchestrationRecoveryRecord,
  OrchestrationRevision,
  OrchestrationSessionId,
  PendingIntentCommitReceipt,
  TerminalNonSubmissionDispositionReceiptV1,
  TerminalNonSubmissionDispositionRef,
  TerminalNonSubmissionProofV1,
} from "@ulte/orchestration-state-store";

/** All records and receipts have already been loaded and validated by their owning service. */
export type LoadedCheckpoint =
  | Readonly<{ readonly status: "VALID"; readonly checkpoint: ExecutionAuthorityCheckpoint }>
  | Readonly<{ readonly status: "MISSING" | "MALFORMED" | "ILLEGAL_REPLAY" }>;

export type LoadedIdempotency =
  | Readonly<{ readonly status: "ABSENT" }>
  | Readonly<{ readonly status: "PRESENT"; readonly record: IdempotencyRecord }>
  | Readonly<{ readonly status: "UNAVAILABLE" }>;

/** A pending effect may have been created by a standalone commit or an adoption's next intent. */
export type PendingCreationProof =
  | Readonly<{ readonly kind: "PENDING_INTENT_COMMIT"; readonly receipt: PendingIntentCommitReceipt }>
  | Readonly<{ readonly kind: "ADOPTION_NEXT_PENDING"; readonly receipt: ExternalOutcomeAdoptionReceipt }>;

export interface LoadedPendingEffect {
  readonly effect: OrchestrationPendingEffect;
  readonly creationProof: PendingCreationProof | null;
  readonly idempotency: LoadedIdempotency;
  /** Existing durable reconciliation request identity, if already known. */
  readonly reconciliationRequestId?: string;
}

export interface LoadedExternalOutcome {
  readonly outcome: OrchestrationExternalOutcome;
  readonly adoptionReceipt: ExternalOutcomeAdoptionReceipt | null;
}

export interface RecoveryBootClassifierInput {
  readonly recovery: OrchestrationRecoveryRecord;
  readonly ownerId: OrchestrationLeaseOwnerId;
  /** Result of a prior authoritative lease/fence check. This classifier never checks time. */
  readonly lease: "VALID" | "INVALID";
  readonly checkpoint: LoadedCheckpoint;
  /** Completeness covers pending, outcome, and receipt enumeration for this recovery revision. */
  readonly evidence: "COMPLETE" | "UNAVAILABLE" | "CORRUPT";
  readonly pendingEffects: readonly LoadedPendingEffect[];
  readonly outcomes: readonly LoadedExternalOutcome[];
  /** Loaded on the same database snapshot; absent for the original C1 classifier callers. */
  readonly terminal?: Readonly<{
    readonly receipt: TerminalNonSubmissionDispositionReceiptV1 | null;
    readonly pending: OrchestrationPendingEffect | null;
    readonly resolvedEffects: readonly OrchestrationPendingEffect[];
    readonly creationProof: PendingCreationProof | null;
    readonly creationCheckpoint: ExecutionAuthorityCheckpoint | null;
    readonly idempotency: LoadedIdempotency;
    readonly leaseFence: OrchestrationFenceToken | null;
  }>;
}

export interface RecoveryBootAuthorityRef {
  readonly sessionId: OrchestrationSessionId;
  readonly ownerId: OrchestrationLeaseOwnerId;
  readonly fenceToken: OrchestrationFenceToken;
  readonly recoveryRevision: OrchestrationRevision;
  readonly checkpointRef: ExecutionAuthorityCheckpointId | null;
}

export interface PendingCreationRef {
  readonly kind: PendingCreationProof["kind"];
  readonly committedCheckpointRef: ExecutionAuthorityCheckpointId;
  readonly committedRevision: OrchestrationRevision;
}

export type RecoveryBootRejectionReason =
  | "LEASE_OR_FENCE_INVALID"
  | "CHECKPOINT_MISSING"
  | "CHECKPOINT_MALFORMED"
  | "ILLEGAL_REPLAY_EVIDENCE"
  | "AUTHORITY_IDENTITY_MISMATCH"
  | "REVISION_MISMATCH"
  | "PENDING_CREATION_PROOF_MISSING"
  | "PENDING_OUTCOME_CONTRADICTION"
  | "RECEIPT_CONTRADICTION"
  | "IDEMPOTENCY_IDENTITY_CONFLICT"
  | "IDEMPOTENCY_ENVIRONMENT_CONFLICT"
  | "FINGERPRINT_CONFLICT"
  | "CONFLICTING_CANONICAL_OUTCOMES"
  | "REQUIRED_EVIDENCE_UNAVAILABLE"
  | "UNSUPPORTED_TERMINAL_NON_SUBMISSION"
  | "TERMINAL_NON_SUBMISSION_PROOF_UNAVAILABLE"
  | "PERSISTENCE_CORRUPTION";

export type RecoveryBootResult =
  | Readonly<RecoveryBootAuthorityRef & { readonly status: "READY" }>
  /** Public proof-backed handoff for a future non-database authority source.
   * The database-only D4 boot path never constructs this variant.
   */
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "TERMINAL_NON_SUBMISSION_REQUIRED";
      readonly checkpointRef: ExecutionAuthorityCheckpointId;
      readonly pendingEffect: OrchestrationPendingEffect & {
        readonly state: "PENDING";
        readonly resolvedOutcomeKey: null;
        readonly resolvedRevision: null;
        readonly resolvedFence: null;
      };
      readonly creationRef: PendingCreationRef;
      readonly idempotency: Extract<LoadedIdempotency, { readonly status: "PRESENT" }> & {
        readonly record: IdempotencyRecord & { readonly status: "FAILED_NOT_SUBMITTED" };
      };
      readonly proof: TerminalNonSubmissionProofV1;
    }>
  /** Validated durable terminal result; the session cannot hydrate or resume execution. */
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "TERMINAL_NON_SUBMISSION";
      readonly checkpointRef: ExecutionAuthorityCheckpointId;
      readonly dispositionRef: TerminalNonSubmissionDispositionRef;
      readonly dispositionReceipt: TerminalNonSubmissionDispositionReceiptV1;
      readonly resolvedPendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity>;
      readonly sessionDisposition: "TERMINAL_NON_SUBMISSION";
    }>
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "INTENT_DISPOSITION_REQUIRED";
      readonly pendingEffect: OrchestrationPendingEffect;
      readonly creationRef: PendingCreationRef;
      readonly idempotency: Exclude<LoadedIdempotency, { readonly status: "UNAVAILABLE" }>;
      readonly dispositionOutcomeKey?: OrchestrationOutcomeKey;
    }>
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "CANONICAL_OUTCOME_REQUIRED";
      readonly pendingEffect: OrchestrationPendingEffect;
      readonly creationRef: PendingCreationRef;
      readonly idempotency: Extract<LoadedIdempotency, { readonly status: "PRESENT" }>;
      readonly dispositionOutcomeKey?: OrchestrationOutcomeKey;
    }>
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "OUTCOME_AVAILABLE";
      readonly outcomeKey: OrchestrationOutcomeKey;
      readonly transitionKind: Extract<OrchestrationExternalOutcome["observation"],
        { readonly kind: "CANONICAL_EXECUTION_TRANSITION" }>["transition"]["kind"];
      readonly pendingEffectIdentity: Readonly<OrchestrationPendingEffectIdentity> | null;
      readonly priorCheckpointRef: ExecutionAuthorityCheckpointId;
    }>
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "RECONCILIATION_REQUIRED";
      readonly pendingEffect: OrchestrationPendingEffect;
      readonly creationRef: PendingCreationRef;
      readonly idempotency: Extract<LoadedIdempotency, { readonly status: "PRESENT" }>;
      readonly reconciliationRequestId?: string;
      readonly dispositionOutcomeKey?: OrchestrationOutcomeKey;
    }>
  | Readonly<RecoveryBootAuthorityRef & {
      readonly status: "RECOVERY_REJECTED";
      readonly reason: RecoveryBootRejectionReason;
      readonly pendingEffectIdentity?: Readonly<OrchestrationPendingEffectIdentity>;
      readonly outcomeKey?: OrchestrationOutcomeKey;
    }>;
