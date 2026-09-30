# Ready trade intent authority restoration V1

## Boundary and authority graph

`READY_TRADE_INTENT_RECOVERY_EVIDENCE_V1` is versioned plain historical
evidence. It is not setup, risk, portfolio, sizing, or trade-intent authority.
`restoreReadyTradeIntent` synchronously replays the complete built-in graph:

1. `restoreSetupCandidateFromAnalysisEvidence`
2. `qualifyStructuralRisk`
3. `evaluatePortfolioRisk`
4. `sizePosition`
5. `createTradeIntent`

Success requires, in order, `SETUP_CANDIDATE_RESTORED`, `QUALIFIED`,
`CAPITAL_ELIGIBLE`, `SIZED`, and `INTENT_READY`. The returned
`setupAuthority`, `riskQualification`, `portfolioRisk`, `sizing`, and
`tradeIntent` are the exact objects from that invocation. In particular,
`tradeIntent` is the object returned by `createTradeIntent`; recovery does not
clone, patch, or construct it.

## Historical inputs and constructors

| Step | Persisted input | Public constructor or authority | Identity and time |
| --- | --- | --- | --- |
| Setup | `SetupCandidateRecoveryEvidenceV1` | `restoreSetupCandidateFromAnalysisEvidence` | PRE0B binds the full candidate selector and analysis `asOf` |
| Structural risk | cost basis points and minimum net R:R config | `createRiskCostAssumptions`, `createRiskQualificationConfig`, then `qualifyStructuralRisk` | candidate, family, direction, instrument, timeframe, and candidate `asOf` |
| Portfolio risk | account snapshot, requested risk, proposed groups, limits | `createAccountRiskSnapshot`, `createPortfolioRiskConfig`, then `evaluatePortfolioRisk` | structural candidate/instrument and exact account/structural `asOf` |
| Position sizing | linear instrument sizing spec and optional FX snapshot | `createLinearInstrumentSizingSpec`, optional `createFxConversionSnapshot`, then `sizePosition` | structural/portfolio candidate, instrument, and `asOf`; FX must use the same `asOf` |
| Trade intent | exact four replayed authority objects | `createTradeIntent` | normal cross-authority coherence checks |

No current defaults or runtime account state participate. Arrays whose domain
has no separate constructor (proposed risk-group IDs) are shape-validated and
then passed to the normal evaluator, which owns their semantic validation.

## Value ownership

The account snapshot owns `baseCurrency`; eligible portfolio risk carries it
forward; sizing owns the final `accountCurrency`. Portfolio requested risk owns
the approved budget, while sizing owns `approvedRiskAmount`, `actualRiskAmount`,
quantity, quantity unit, conversion, and all sizing economics. Structural risk
owns prices, structural net risk, and net reward-to-risk. `createTradeIntent`
copies these authoritative values only after its normal coherence checks.
Recovery performs none of their arithmetic.

## Intent identity and selector

The normal V1 `intentId` length-prefixes schema version, candidate ID,
instrument ID, `asOf`, direction, entry reference, invalidation, primary target,
quantity, and account currency. It does not cover family, context/setup
timeframes, quantity unit/step, PnL currency, conversion rate, approved/actual/
unused risk, utilization, structural net risk, net R:R and its configured
minimum, PnL value, risk-per-quantity values, or maximum-quantity capping.

The expected-intent selector therefore binds the ID and every exposed
authoritative `ReadyTradeIntent` field other than its constant status and schema
version. It is verification only. A mismatch rejects; selector data is never
copied into the result.

## Rejection and scope

The frozen discriminated result distinguishes invalid/unsupported evidence,
upstream setup rejection, invalid risk constructors, non-qualified risk,
invalid account or portfolio config, non-eligible portfolio authority, invalid
sizing or FX constructors, non-sized authority, trade-intent rejection, and
final selector mismatch. Upstream statuses and reasons are retained when normal
authorities provide them.

Restoration is pure, synchronous, deterministic, and local. It reads no clock,
random source, current configuration, broker, network, repository, or database.
It performs no financial calculation and makes no execution-preparation or
execution authority claim.
