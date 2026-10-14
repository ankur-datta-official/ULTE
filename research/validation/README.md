# Alpha baseline validation input

## Task058 fixed core-universe research baseline

`ALPHA_RESEARCH_POLICY_V1.json` freezes the untuned Task056 alpha-sensitive
settings, the Binance USD-M 1h/4h/1d roles, the canonical 15m path, the
3.00 net-R floor, costs, the eight-symbol product universe, and the historical
cutoff. It is a research policy, not an approved production strategy config.
The root `TRADING_INTELLIGENCE_CORE_UNIVERSE_BASELINE_AUDIT.txt` is the
authoritative universe result. `CORE_UNIVERSE_DATA_MANIFEST_V1.json` records
official archive checksums and per-symbol data quality. Raw ZIPs, normalized
candles, and per-symbol replay/result JSON remain ignored under
`research/data/core_universe_v1/`.

From the repo root, after building the shared TypeScript packages:

```text
python research/validation/download_core_universe.py
python research/validation/download_core_gap_days.py
python research/validation/prepare_core_universe.py
node research/validation/replay_core_universe.mjs
python research/validation/summarize_core_universe.py
python research/validation/write_core_universe_audit.py
```

The downloader reads Binance's official archive index and verifies each ZIP
against its adjacent published SHA-256 checksum. The gap-day step inspects
verified monthly 15m rows and fetches official daily ZIPs only for complete,
day-aligned missing intervals. Preparation fails if the official daily rows
do not cover a gap exactly. Published higher timeframes are checked where
present but never enter signal decisions. The replay calls the actual shared
regime, structure, setup, decision, and risk engines for every closed 1h
cycle; the 15m path is read separately for outcome and counterfactual MFE/MAE.
Signal eligibility precedes research-only portfolio/sizing context, so
otherwise eligible signals are not removed by provisional live limits.

BTC uses the earlier verified `RESEARCH_TARGET_V1.json` and local Task056
canonical data; its four baseline fills and R values are reproduced exactly.
No market-data open or funding event timestamp from 2026-10-01 onward is
permitted. The last pre-cutoff bar closes at that exclusive boundary.

## Task056 integrity status

The authoritative conclusion is `TRADING_INTELLIGENCE_PRODUCTION_EQUIVALENT_BASELINE_AUDIT.txt`
at the repository root. The corrected exploratory replay derives 1h, 4h and
1d UTC candles solely from the complete, checksum-verified official 15m series.
Separately downloaded higher timeframe archives remain QA comparison sources;
field-level conflicts are recorded in `RESEARCH_TARGET_V1.json`.

There is no application composition or production strategy default in this
repository. `REPLAY_CONFIG_EXPLORATORY_V1.json` is an explicit, immutable
research snapshot of test-based settings, not a production profile. The replay
uses the shared analysis and decision engines and a causal research account:
10,000 USDT initial equity, 1% of then-current equity requested as risk,
open-position risk visible to the portfolio gate, and equity updates at
observed exits and funding settlements. The ledger is independently reconciled
by `alpha_baseline.py`.

`WALK_FORWARD_PROTOCOL_V1.md` locks the historical windows. The old
2025-07-01 through 2026-09-30 final OOS is burned for research diagnostics;
2026-10-01 onward is reserved for true forward shadow evidence. Current
historical results cannot certify production equivalence or alpha.

## Official OHLCV file intake

The repository has no production analysis thresholds. `RESEARCH_TARGET_V1.json`
freezes a BTCUSDT USD-M dataset, while its
replay uses explicitly labeled test settings and remains exploratory. The
generic `import_ohlcv.py` accepts a local CSV
retrieved from the chosen official venue source. Its exact UTF-8 header is:

`open_time,open,high,low,close,volume`

`open_time` is either Unix milliseconds or UTC ISO-8601 ending in `Z`. It is
the inclusive candle open. The exclusive close and availability time are
`open_time + timeframe duration`. All other fields are plain decimal strings.
Rows must be chronological, unique, complete, interval aligned, OHLC valid,
and no later than the declared UTC retrieval instant. Gaps and malformed rows stop
the import; nothing is forward filled. The caller supplies the UTC timeframe
anchor (zero for Unix-aligned intervals). The official source URL and retrieval
instant are provenance declarations and require independent verification.

Example after choosing the real target and downloading its official CSV:

```text
python research/validation/import_ohlcv.py --input research/data/source.csv --output-dir research/data/normalized --source-url OFFICIAL_HTTPS_URL --retrieved-at-utc YYYY-MM-DDTHH:MM:SSZ --venue VENUE --market-type MARKET_TYPE --instrument-id ulte:v1:VENUE:KIND:SYMBOL --timeframe SETUP_TIMEFRAME --anchor-ms UTC_ANCHOR_OFFSET
```

Outputs are `candles.json` and `manifest.json` with source and normalized
SHA-256 checksums, quality summary, and frozen 60/20/20 chronological split
boundaries. `research/data/` is ignored by Git. The manifest says
`sourceVerified=false` because an operator supplied the URL and file; neither
the importer nor a checksum authenticates market provenance. The importer
does not generate paired ULTE analysis/decision observations. Certification
also requires a frozen production strategy configuration, time-aligned
account/risk context, sufficient trades, and resolved source quality exceptions.

## BTCUSDT research target V1

Run `python research/validation/download_binance_btcusdt.py`, then
`python research/validation/prepare_binance_btcusdt.py` from the repository
root. These commands fetch 81 monthly archives for each of 15m, 1h, 4h, 1d,
and fundingRate from Binance Public Data, verify every ZIP against its official
`.CHECKSUM`, normalize each kline series with the existing importer, and write
the tracked `RESEARCH_TARGET_V1.json` manifest. Archives and normalized data
stay under ignored `research/data/binance_btcusdt_v1/`.

After `npm run typecheck`, run
`node research/validation/replay_binance_btcusdt.mjs`. It forwards closed 1h,
4h, and 1d candles derived from 15m into the shared analysis and decision
engines at their UTC close boundaries, exports paired cycles, and never passes
15m detail into signal creation. Its fixed thresholds are drawn from engine
tests, not a production configuration. The account starts at a disclosed
10,000 USDT and changes only as observed fills and funding occur.
Run `node research/validation/verify_binance_btcusdt_replay.mjs` to check every
paired boundary and frame for future or open candles.

Run `python research/validation/alpha_baseline.py --input
research/data/binance_btcusdt_v1/replay.json --output-dir
research/data/binance_btcusdt_v1/baseline --worse-cost`. The worse-cost pass
adds one basis point each to spread and entry/exit slippage without changing
signals. The 15m/derived-1h path must reconcile exactly. Official higher
timeframe archive differences remain in the manifest. No large source or
replay files are tracked by Git. Run `python
research/validation/decision_funnel.py` and `python
research/validation/summarize_corrected_baseline.py` for the gate counts and
locked forward-window summary.

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
  assumptions; calibrate them to the instrument and venue. Fixed funding is a
  debit per held setup candle only when actual funding events are not supplied.
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
- `executionCandles` (optional): a complete aligned 15m path for every 1h
  candle. It is used only for fills and MFE/MAE, never for decisions.
- `fundingEvents` (optional): chronological `{time, intervalHours, rate}`
  settlements, replacing the fixed per-candle funding debit.

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
When both are touched within one execution-detail bar, stop wins. Fees apply
to entry and exit price. Actual funding events are charged when supplied;
funding uses entry notional as an explicit approximation because the archive
lacks settlement mark prices. R uses the simulated entry-to-stop distance plus
entry and stop fees as denominator. MFE and MAE are conservative lower bounds:
the exit candle contributes its open and proven exit barrier, not the unknown
opposite wick. The model has no order-book queue, market-impact, or partial-fill
evidence, and ordering within each 15m bar remains unknown.

Trades are assigned to a segment by entry time. Any trade exiting across a
train/validation or validation/burned-diagnostics boundary is marked
`splitEligible=false` and excluded from split metrics. Sample labels are
VERY_INSUFFICIENT below 30, INSUFFICIENT at 30-49, LIMITED at 50-99, and
USABLE_BASELINE at 100+; none implies statistical proof. Wilson win-rate and
seeded percentile bootstrap expectancy intervals are descriptive.
Profit factor is null when there are no losses. Breakeven trades count in the
sample but neither win nor loss rate. Target hit counts are cumulative realized
target exits at gross 1R, 2R, 3R, or 4R and above. The current engine has no
score or probability, so score calibration is explicitly unavailable.

The harness always sets `certified=false`: no production strategy config or
pristine OOS exists, and four trades are far too few for an alpha conclusion.
`eligibleForEvidenceReview` remains false until those gaps are addressed.
