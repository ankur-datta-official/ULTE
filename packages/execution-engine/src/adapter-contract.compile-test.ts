import type {
  CancellationSubmissionResponse,
  EntryCancellationRequest,
  EntrySubmissionRequest,
  EntrySubmissionResponse,
  ExecutionAdapter,
  FillEvent,
  ProtectionRequest,
  ProtectionSubmissionResponse,
} from "./types.js";

type Expect<Condition extends true> = Condition;
type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type _EntryIsPromiseReturning = Expect<IsExact<
  ReturnType<ExecutionAdapter["submitEntry"]>,
  Promise<EntrySubmissionResponse>
>>;
type _ProtectionIsPromiseReturning = Expect<IsExact<
  ReturnType<ExecutionAdapter["submitProtection"]>,
  Promise<ProtectionSubmissionResponse>
>>;
type _CancellationIsPromiseReturning = Expect<IsExact<
  ReturnType<ExecutionAdapter["cancelEntry"]>,
  Promise<CancellationSubmissionResponse>
>>;
type _FillIsNotEntrySubmissionResponse = Expect<
  Extract<EntrySubmissionResponse, FillEvent> extends never ? true : false
>;

interface PromiseReturningImplementation {
  readonly capabilities: ExecutionAdapter["capabilities"];
  submitEntry(request: EntrySubmissionRequest): Promise<EntrySubmissionResponse>;
  submitProtection(request: ProtectionRequest): Promise<ProtectionSubmissionResponse>;
  cancelEntry(request: EntryCancellationRequest): Promise<CancellationSubmissionResponse>;
}

type _PromiseImplementationSatisfiesAdapter = Expect<
  PromiseReturningImplementation extends ExecutionAdapter ? true : false
>;

export {};
