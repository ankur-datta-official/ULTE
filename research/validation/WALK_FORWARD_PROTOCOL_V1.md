# BTCUSDT historical validation protocol V1

Locked before the Task056 corrected replay is evaluated. This protocol uses the
current, untuned shared trading rules. No parameter selection is permitted from
these results.

## Data status

- Historical data: 2020-01-01T00:00:00Z through 2026-10-01T00:00:00Z exclusive.
- The previously named final OOS, 2025-07-01T00:00:00Z through
  2026-10-01T00:00:00Z exclusive, is **BURNED_FOR_RESEARCH_DIAGNOSTICS**. It was
  inspected during exploratory configuration selection. It is historical
  research data, not untouched OOS.
- **FINAL_PRISTINE_OOS_AVAILABLE = NO**.
- **TRUE_FORWARD_HOLDOUT_START = 2026-10-01T00:00:00Z**. Once acquired, data
  from this instant onward is reserved for shadow/forward certification and
  must not be used for historical optimization.

## Fixed expanding windows (UTC, start inclusive, end exclusive)

The first train window is 2020-01-01 to 2022-01-01. Validation is the next
calendar year, and forward evaluation is the next calendar year. Advance by
one calendar year. All windows are fixed here before corrected PnL is read.

| Fold | Train | Validation | Next forward evaluation |
| --- | --- | --- | --- |
| 1 | 2020-01-01 to 2022-01-01 | 2022-01-01 to 2023-01-01 | 2023-01-01 to 2024-01-01 |
| 2 | 2020-01-01 to 2023-01-01 | 2023-01-01 to 2024-01-01 | 2024-01-01 to 2025-01-01 |
| 3 | 2020-01-01 to 2024-01-01 | 2024-01-01 to 2025-01-01 | 2025-01-01 to 2026-01-01 |
| 4 | 2020-01-01 to 2025-01-01 | 2025-01-01 to 2026-01-01 | 2026-01-01 to 2026-10-01 |

Train and validation windows provide context only in Task056; there is no
fitting or model choice. Count an executed trade in a fold's forward window
only if both entry and exit occur inside it. Report counts and metrics for
each fold, including zero-trade folds. The repeated forward windows do not
become pristine OOS by being called walk-forward.

When fewer than 30 executed trades exist overall, performance is
VERY_INSUFFICIENT and parameter tuning is prohibited. The same applies to
subgroup claims with tiny counts. Costs and fill assumptions must be frozen
before the corrected replay; report sensitivity separately.
