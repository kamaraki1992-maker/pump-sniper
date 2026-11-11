import type { Logger } from "./logger.js";

export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "unhandled-error";
}

/**
 * Node exits on an unhandled rejection. These listeners log it and leave the
 * process running so a bad websocket frame cannot take the bot down.
 */
export function reportRejection(log: Logger, reason: unknown): void {
  log.error("unhandled rejection", { error: errorText(reason) });
}

export function installProcessGuards(log: Logger): () => void {
  const onRejection = (reason: unknown) => {
    reportRejection(log, reason);
  };
  const onException = (error: Error) => {
    log.error("uncaught exception", { error: errorText(error) });
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
