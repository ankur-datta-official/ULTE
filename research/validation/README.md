# Alpha baseline validation input

`alpha_baseline.py` measures exported results from the existing ULTE replay,
analysis, and decision engines. It never generates signals, scores, structural
prices, or risk approval. The input is one UTF-8 JSON object:

- `metadata`: nonempty `datasetId`, `instrumentId`, setup `timeframe`, `source`,
  and `codeRevision` strings. The output records a SHA-256 hash of the entire
  input file. These provenance fields are supplied by the exporter and require
  independent review before any alpha claim.
- `config`: integer UTC millisecond `trainEnd` and `validationEnd`, plus
  nonnegative integer `entryFeeBps`, `exitFeeBps`, `entrySlippageBps`,
  `exitSlippageBps`, `spreadBps`, and `fundingBpsPerCandle`. These are explicit
  assumptions; calibrate them to the instrument and venue. Funding is a debit
  per held setup candle, not a time-stamped funding settlement model.
- `candles`: real, complete, contiguous, chronological closed setup-timeframe
  candles with `instrumentId`, `timeframe`, `openTime`, `closeTime`, `open`,
  `high`, `low`, `close`, `isClosed`, and `quality`. Prices are decimal strings.
  No missing candle is synthesized. A gap, even when unmarked, is rejected.
- `observations`: chronological `{ "analysis": AnalysisCycleResult,
  "decision": PublishedDecisionResult }` pairs from the same cycle, exported
  during forward replay. Include no-decision and rejected cycles. The full
  analysis frame permits a second check that higher-timeframe candles were
  closed by the decision boundary. Accepted intents must preserve the setup,
  qualified structural risk, and ready intent produced by the existing engines.

Run with `python research/validation/alpha_baseline.py --input INPUT.json
--output-dir OUTPUT_DIR`. Results are `alpha_baseline.json` (ledger, R curve,
metrics, splits, regime/volatility, setup, MTF pair, no-trade reasons, counts,
hash) and `alpha_baseline.txt`. Identical
input bytes and code produce identical outputs. The fixture in the unit tests
only exercises mechanics; it is not market evidence.

The next setup candle opens at the decision boundary; entry is its open with
adverse slippage and spread. An absent next candle is counted without filling.
Only one position is simulated at a time, and a candidate ID can enter once.
Stops fill at the worse of the stop level or candle open, then incur adverse
exit slippage. Targets fill at their level, then incur adverse exit slippage.
When both are touched, stop wins. Fees apply to entry and exit price; funding
is charged per held candle. R uses the simulated entry-to-stop distance plus
entry and stop fees as denominator. MFE and MAE are conservative lower bounds:
the exit candle contributes its open and proven exit barrier, not the unknown
opposite wick. The model has no order-book queue, market-impact, partial-fill,
or intrabar-path evidence.

Trades are assigned to a segment by entry time. Any trade exiting across a
train/validation or validation/test boundary is marked `splitEligible=false`
and excluded from split metrics. `sampleStatus=INSUFFICIENT_SAMPLE` below 30
closed trades per bucket is a reporting threshold, not a significance test.
Profit factor is null when there are no losses. Breakeven trades count in the
sample but neither win nor loss rate. Target hit counts are cumulative realized
target exits at gross 1R, 2R, 3R, or 4R and above. The current engine has no
score or probability, so score calibration is explicitly unavailable.

The harness always sets `certified=false`: a result file alone cannot verify
market provenance, historical point-in-time risk context, venue costs, or
representative OOS coverage. `eligibleForEvidenceReview` only marks a complete
run with at least 30 total and 30 test trades as ready for human/source review.
