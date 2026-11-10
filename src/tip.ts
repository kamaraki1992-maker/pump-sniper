import type { AppConfig } from "./config.js";

/** Tip for one trade. Emergency exits pay the configured maximum, still inside the hard cap. */
export function tipForTrade(config: AppConfig, tradeSizeSol: number, emergency = false): number {
  if (config.tipMode === "fixed") return config.jitoTipSol;
  if (emergency) return config.jitoTipMaxSol;
  const raw = (Number.isFinite(tradeSizeSol) && tradeSizeSol > 0 ? tradeSizeSol : 0) * config.jitoTipPct;
  const lamports = Math.round(raw * 1e9);
  const min = Math.round(config.jitoTipMinSol * 1e9);
  const max = Math.round(config.jitoTipMaxSol * 1e9);
  return Math.min(max, Math.max(min, lamports)) / 1e9;
}

export function isEmergencyExit(reason: string): boolean {
  return reason === "sl" || reason === "dev_sell" || reason === "fast_drop";
}
