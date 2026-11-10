const SECRET_FIELD =
  /("(?:privateKey|secretKey|secret|PRIVATE_KEY)"\s*:\s*")[^"]*/gi;

/**
 * Remove registered secrets and common secret field values from text.
 * Transaction signatures are also ~88-character base58, so this layer does
 * not blanket-redact that shape — it redacts the exact key material it was
 * given, plus JSON fields that are named like secrets.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 16) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  out = out.replace(SECRET_FIELD, '$1[REDACTED]');
  return redactRpcUrl(out);
}

/** Strip api-key and PumpDev `key` query values so a WebSocket URL can be logged. */
export function redactRpcUrl(text: string): string {
  return text.replace(/([?&](?:api-key|api_key|apikey|key)=)[^&\s"]+/gi, "$1[REDACTED]");
}

export function rpcApiKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get("api-key") ??
      parsed.searchParams.get("api_key") ??
      parsed.searchParams.get("apikey")
    );
  } catch {
    const match = url.match(/[?&](?:api-key|api_key|apikey|key)=([^&\s"]+)/i);
    return match?.[1] ?? null;
  }
}

export function installProcessRedaction(secrets: readonly string[]): void {
  const wrap = (stream: NodeJS.WriteStream): void => {
    const original = stream.write.bind(stream) as typeof stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") {
        return original(redact(chunk, secrets), ...(rest as never[]));
      }
      if (Buffer.isBuffer(chunk)) {
        const text = chunk.toString("utf8");
        const cleaned = redact(text, secrets);
        if (cleaned !== text) {
          return original(cleaned, ...(rest as never[]));
        }
      }
      return original(chunk as never, ...(rest as never[]));
    }) as typeof stream.write;
  };
  wrap(process.stdout);
  wrap(process.stderr);
}
