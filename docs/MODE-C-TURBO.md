# Mode C — SMART STRICT / TURBO (EA 2.31)

Risk-Bounded Adaptive Execution: execute fast when conditions allow, size the lot from a conservative price, refuse/defer when the risk limit cannot be met.

## Flow of a market reversal (`TryMarketReverse`)
1. Quoted price (Ask/Bid) and SL = opposite level. Max Reversal Gap check.
2. `RecoveryGuardBlocks` (sequence/risk caps).
3. `devPts = TurboDeviationLimit()` = min(ceiling, MaxSlippage + 2×spread [+ ½·MomPts when hot]).
4. `sizeEntry = TurboWorstEntry()` (Buy: Ask+dev, Sell: Bid−dev). Lot = `CalcLotSL(risk, sizeEntry, SL)` (STRICT: no legal lot → WAIT).
5. `TP = TPPriceLot(final lot)`, anchored at the quoted price.
6. `MarketPreflight` → delete pending → send with `SetDeviationInPoints(devPts)` → restore `g_maxDev`.
7. After the fill: `RegisterPosition` logs slippage and the real worst-case loss at SL; `RISKOVER` alert if above target. The real result enters the cumulative loss only after the close (deal history).

## Single ceiling
`InpTurboDevPts` (TURBO on) / `Max Slippage Check` (TURBO off) = `TurboDevCeiling()`. Nothing widens it.

## Not covered (be explicit)
Pending Buy/Sell Stop fills (broker-side price), gaps, thin liquidity, delayed emergency close, commission not known before the first closed trade, guaranteed stop-loss. Compile with F7, then Strategy Tester and a demo account (see MT5-TESTING.md) before live.
