import type {
  CancellationSubmissionResponse,
  EntryCancellationRequest,
  EntrySubmissionRequest,
  EntrySubmissionResponse,
  ProtectionRequest,
  ProtectionSubmissionResponse,
} from "@ulte/execution-engine";
import type {
  BrokerAdapter,
  BrokerAdapterDescriptor,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyOutcomeInput,
  IdempotencyRecord,
  IdempotencyRepository,
} from "./index.js";

type Expect<Condition extends true> = Condition;
type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

interface FutureAdapterImplementation {
  readonly descriptor: BrokerAdapterDescriptor;
  readonly capabilities: BrokerAdapterDescriptor["capabilities"];
  submitEntry(request: EntrySubmissionRequest): Promise<EntrySubmissionResponse>;
  submitProtection(request: ProtectionRequest): Promise<ProtectionSubmissionResponse>;
  cancelEntry(request: EntryCancellationRequest): Promise<CancellationSubmissionResponse>;
}

interface FutureRepositoryImplementation {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  read(
    adapterId: IdempotencyClaimInput["adapterId"],
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined>;
  recordOutcome(input: IdempotencyOutcomeInput): Promise<IdempotencyRecord>;
}

type _FutureAdapterSatisfiesContract = Expect<
  FutureAdapterImplementation extends BrokerAdapter ? true : false
>;
type _FutureRepositorySatisfiesContract = Expect<
  FutureRepositoryImplementation extends IdempotencyRepository ? true : false
>;
type _EntryRequestIsExecutionEngineRequest = Expect<IsExact<
  Parameters<BrokerAdapter["submitEntry"]>[0],
  EntrySubmissionRequest
>>;
type _ProtectionRequestIsExecutionEngineRequest = Expect<IsExact<
  Parameters<BrokerAdapter["submitProtection"]>[0],
  ProtectionRequest
>>;
type _CancellationRequestIsExecutionEngineRequest = Expect<IsExact<
  Parameters<BrokerAdapter["cancelEntry"]>[0],
  EntryCancellationRequest
>>;
type _EntryResponseIsPromise = Expect<IsExact<
  ReturnType<BrokerAdapter["submitEntry"]>,
  Promise<EntrySubmissionResponse>
>>;
type _ProtectionResponseIsPromise = Expect<IsExact<
  ReturnType<BrokerAdapter["submitProtection"]>,
  Promise<ProtectionSubmissionResponse>
>>;
type _CancellationResponseIsPromise = Expect<IsExact<
  ReturnType<BrokerAdapter["cancelEntry"]>,
  Promise<CancellationSubmissionResponse>
>>;

export {};
