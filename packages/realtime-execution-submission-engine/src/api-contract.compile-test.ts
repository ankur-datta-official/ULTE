import type { RealtimeExecutionSubmissionContext } from "./index.js";

type RawSecretField = Extract<
  keyof RealtimeExecutionSubmissionContext,
  "apiKey" | "apiSecret" | "password" | "privateKey" | "accessToken"
>;
type AssertNever<Value extends never> = Value;

export type SubmissionContextHasNoRawSecretFields = AssertNever<RawSecretField>;
