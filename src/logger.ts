import { redact } from "./redact.js";

export class Logger {
  constructor(private readonly secrets: readonly string[] = []) {}

  info(message: string, fields?: Record<string, unknown>): void {
    process.stdout.write(this.format("info", message, fields) + "\n");
  }

  error(message: string, fields?: Record<string, unknown>): void {
    process.stderr.write(this.format("error", message, fields) + "\n");
  }

  format(level: string, message: string, fields?: Record<string, unknown>): string {
    const payload = {
      level,
      message,
      ...fields,
    };
    return redact(JSON.stringify(payload), this.secrets);
  }
}
