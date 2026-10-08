/** The cache calls that keep a session key. */
export interface SessionKeys {
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
}

/**
 * Keep a session key after its checks pass. Returns false when the session ended meanwhile.
 * A request slides the idle timeout, capped by the absolute lifetime.
 * An event stream recheck only confirms the key, so an open tab never extends an unattended session.
 */
export async function retainSession(
  keys: SessionKeys,
  key: string,
  options: {
    slide: boolean;
    idleSeconds: number;
    /** Absolute expiry in epoch milliseconds. */
    expiresAt: number;
    now?: number;
  },
): Promise<boolean> {
  if (!options.slide) return (await keys.exists(key)) > 0;
  const remaining = Math.floor(
    (options.expiresAt - (options.now ?? Date.now())) / 1000,
  );
  return (
    (await keys.expire(
      key,
      Math.max(1, Math.min(options.idleSeconds, remaining)),
    )) > 0
  );
}
