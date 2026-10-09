import {
  createTerminalNonSubmissionDispositionReceiptV1, createTerminalNonSubmissionDispositionV1,
  createTerminalNonSubmissionProofV1, equivalentTerminalNonSubmissionDispositionRetry,
  terminalNonSubmissionDispositionRef,
  type TerminalNonSubmissionDispositionLogicalPayload,
  type TerminalNonSubmissionDispositionReceiptV1, type TerminalNonSubmissionDispositionV1,
  type TerminalNonSubmissionProofV1, type TerminalNonSubmissionSessionDisposition,
} from "./index.js";

declare const raw: unknown;
declare const receipt: TerminalNonSubmissionDispositionReceiptV1;
declare const disposition: TerminalNonSubmissionDispositionV1;
declare const logical: TerminalNonSubmissionDispositionLogicalPayload;
const proof: TerminalNonSubmissionProofV1 = createTerminalNonSubmissionProofV1(raw);
const created: TerminalNonSubmissionDispositionV1 = createTerminalNonSubmissionDispositionV1(raw);
const createdReceipt: TerminalNonSubmissionDispositionReceiptV1 = createTerminalNonSubmissionDispositionReceiptV1(raw);
const same: boolean = equivalentTerminalNonSubmissionDispositionRetry(receipt, logical);
const ref = terminalNonSubmissionDispositionRef("terminal-1");
const onlyTerminal: TerminalNonSubmissionSessionDisposition = "TERMINAL_NON_SUBMISSION";
// @ts-expect-error The session cannot resume after a terminal disposition.
const cannotResume: TerminalNonSubmissionSessionDisposition = "RESUME";
// @ts-expect-error An unvalidated string is not a disposition reference.
const unbranded: TerminalNonSubmissionDispositionV1["dispositionRef"] = "terminal-1";
// @ts-expect-error Retry-safe evidence cannot be represented in a validated proof.
const retrySafe: TerminalNonSubmissionProofV1["retryDisposition"] = "RETRY_SAFE";
// @ts-expect-error Historical owner is not current retry authorization.
logical.committingOwnerId;
// @ts-expect-error Historical commit fence is not a logical request field.
logical.committedFence;
// @ts-expect-error Terminal disposition is immutable.
disposition.sessionDisposition = "TERMINAL_NON_SUBMISSION";
void proof; void created; void createdReceipt; void same; void ref; void onlyTerminal;
void cannotResume; void unbranded; void retrySafe;
