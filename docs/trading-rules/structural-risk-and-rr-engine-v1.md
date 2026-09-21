# Structural risk and net reward-to-risk engine V1

## Purpose and boundary

`@ulte/risk-engine` deterministically evaluates whether a position-setup hypothesis satisfies structural-risk and net reward-to-risk requirements. Only a `CONFIRMED` setup can be fully evaluated. A `QUALIFIED` result means the hypothesis passed these rules; it is not an order, execution instruction, profitability claim, win-rate estimate, or position-sizing decision.

## Entry, invalidation, and targets

The entry reference is the exact close of the setup candle that corresponds to the candidate's confirmation event or breakout retest. It is a qualification reference, not a broker fill. Continuation and reversal invalidation is the initiating sweep candle's low for an UP hypothesis and high for a DOWN hypothesis. Breakout-retest invalidation uses the retest candle's corresponding low or high. V1 applies no stop buffer.

Targets come only from active structural liquidity levels confirmed by the evaluation time. UP hypotheses use buy-side levels strictly above entry; DOWN hypotheses use sell-side levels strictly below entry. The path is ordered nearest to farthest with equal-price levels retaining source order. The nearest eligible level is always primary, even when a farther level would pass the reward-to-risk threshold.

## Costs and net reward-to-risk

Callers must explicitly supply all-in entry, target-exit, and stop-exit cost assumptions as non-negative integer basis points. Gross risk and reward are structural price distances. Entry and stop-exit costs increase net risk; entry and target-exit costs reduce net reward. These assumptions are caller inputs and are not claimed to represent any broker.

All price, cost, and ratio calculations use exact decimal/integer arithmetic. Eligibility uses exact cross multiplication, while the exposed `netRewardRiskBps` is a floored display value where `10,000` is 1R. ULTE never accepts a configured minimum below `30,000` (3.00R), and a caller may require more. The 3R floor is an eligibility constraint, not a claim that a setup is optimal or will win.

## Time and data policy

The candidate's `asOf` is authoritative. Structure windows, confirmation evidence, and every supplied setup candle must be known by that time. Future supplied candles cause explicit data rejection; they are never filtered. Future liquidity levels cannot enter the target path. Inputs are not sorted or repaired, and missing evidence is not substituted. Results and their target paths are immutable and deterministic, with no wall-clock or random dependency.
