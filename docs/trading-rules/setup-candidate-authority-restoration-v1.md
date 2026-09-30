# Setup candidate authority restoration V1

## Authority boundary

`SETUP_CANDIDATE_RECOVERY_EVIDENCE_V1` is plain historical evidence, not analysis
authority. `restoreSetupCandidateFromAnalysisEvidence` restores every context and
setup candle through `restoreFinalizedCandleSnapshot`, recreates every historical
configuration through its public constructor, and invokes only the built-in chain:

1. `classifyMarketRegime`
2. `analyzeMarketStructure`
3. `evaluatePositionSetups`

The evidence binds that implementation as
`BUILTIN_REGIME_STRUCTURE_SETUP_V1`. Missing, custom, or unknown implementation
identities reject. V1 does not claim to reproduce output from evaluators injected
into `RealtimeAnalysisEngine`.

The successful result retains the exact ordered restored context and setup candle
references, the exact regime and structure results supplied to setup evaluation,
the exact setup evaluation result, and the selected candidate object from that
result. In particular, the returned `candidate` is not cloned or reconstructed.
The result wrapper and its candle arrays are frozen; upstream authority objects are
left unchanged.

## Historical configuration

No defaults or current runtime configuration participate in replay.

| Family | Persisted plain fields | Constructor | Result | Ordering |
| --- | --- | --- | --- | --- |
| Regime | `trendLookback`, baseline/recent volatility bars, trend/range efficiency and consistency thresholds, compression/expansion thresholds | `createRegimeConfig` | frozen shallow canonical object | field order has no meaning |
| Structure | `lookbackBars`, `pivotLeftBars`, `pivotRightBars` | `createStructureConfig` | frozen shallow canonical object | field order has no meaning |
| Setup | continuation, breakout, and reversal regime allowlists | `createPositionSetupConfig` | frozen object with separately frozen copied lists | list order is preserved, although V1 membership checks do not make it output-significant |

`analysisAsOf` is reconstructed with `unixMs` and supplied unchanged to setup
evaluation. The expected candidate's `asOf` must equal it. Normal regime,
structure, and setup validation owns candle chronology, gaps, readiness, upstream
window timing, instrument identity, and timeframe identity; recovery neither sorts
nor repairs evidence.

## Candidate identity

The normal V1 candidate ID is
`family:direction:initiatedAt:initiationReferenceSwingId`. It does not cover the
instrument, context timeframe, setup timeframe, analysis `asOf`, stage, or
confirmation time. Recovery therefore first finds the requested ID and then binds
all exposed lineage fields: ID, family, direction, stage, instrument, both
timeframes, `asOf`, initiation time, and optional confirmation time. Zero ID
matches reject as not found, an ID match with different lineage rejects as an
identity mismatch, and multiple complete matches reject as ambiguous. Selection
never falls back to array position.

## Rejections and scope

V1 distinguishes invalid evidence, unsupported schema or implementation, invalid
analysis time, invalid configuration by family, candle restoration failure with
role/index and upstream reason, non-ready regime, non-ready structure, rejected
setup evaluation, missing candidates, lineage mismatch, and ambiguity.

This is a pure synchronous historical replay. It restores no realtime cycle cache,
cycle ID, publication boundary, live-ingestion epoch, dedupe state, open bucket,
sequence watermark, or future stream state. It performs no persistence, broker,
network, clock, randomness, or financial calculation. Durable evidence storage and
restart coordination remain later-phase work.
