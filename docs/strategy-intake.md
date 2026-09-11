# Strategy intake

Updated: 2026-09-09. Japanese version: [戦略導入手順](./strategy-intake.ja.md).

## Non-negotiable rules

1. **Borrow ideas, not code.** Check every third-party license before use and record accepted notices in `THIRD_PARTY_NOTICES.md`.
2. **Never promise profitability.** Every new strategy begins as a research candidate; its output is observation, not investment advice.
3. **Do not skip gates.** Only strategies that pass all six steps may enter internal paper research and forward validation.

## Six gates

1. **Source review:** record the idea's source, intended regime, and claimed edge.
2. **Independent implementation:** implement the signal and test yourself; add its three-language catalogue definition.
3. **Backtest and out-of-sample:** include spread and slippage, use a 70/30 OOS split, and prohibit look-ahead bias.
4. **Robustness:** use three rolling segments and fixed-seed Monte Carlo; review P5 return and P95 drawdown.
5. **Forward validation:** after research gates pass, record only completed bars and human-confirmed observations.
6. **Human review:** a strategy that meets the observation, confirmation, and logic-consistency thresholds may be reviewed by a person. This is never live-trading permission.

## Reject a candidate when

- it claims guaranteed returns or cannot explain its source;
- its parameters cannot be explained and indicate likely overfitting; or
- it depends on irreproducible external data and cannot safely degrade.
