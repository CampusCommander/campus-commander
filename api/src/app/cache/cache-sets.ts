/**
 * Claim members in a sorted set. Each score is that member's expiry in epoch milliseconds.
 * The script drops expired members, then adds each absent member with the Redis clock plus ARGV[1] seconds.
 * It returns the members that it added. A one-hour key expiry removes an abandoned set.
 */
export const addMembersScript =
  "local t=redis.call('TIME') local now=t[1]*1000+math.floor(t[2]/1000) redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now) local added={} for i=2,#ARGV do if redis.call('ZADD',KEYS[1],'NX',now+tonumber(ARGV[1])*1000,ARGV[i])==1 then added[#added+1]=ARGV[i] end end redis.call('EXPIRE',KEYS[1],3600) return added";

/**
 * Read a list slice and its length in one command.
 * KEYS[1] is the list. ARGV[1] and ARGV[2] are the first and last index. It returns {length, items}.
 */
export const listSliceScript =
  "return {redis.call('LLEN',KEYS[1]),redis.call('LRANGE',KEYS[1],ARGV[1],ARGV[2])}";

/**
 * Replace a list and set its expiry in one command.
 * KEYS[1] is the list. ARGV[1] is the expiry in seconds. ARGV[2] onward are the IDs.
 * The script pushes at most 1000 IDs per call because Lua unpack has a stack limit.
 */
export const replaceListScript =
  "redis.call('DEL',KEYS[1]) for i=2,#ARGV,1000 do redis.call('RPUSH',KEYS[1],unpack(ARGV,i,math.min(i+999,#ARGV))) end redis.call('EXPIRE',KEYS[1],tonumber(ARGV[1])) return 1";

export function memberChunks(members: readonly string[], size = 1000): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < members.length; start += size)
    chunks.push(members.slice(start, start + size));
  return chunks;
}
