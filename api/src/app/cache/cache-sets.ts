/** SADD each member. Return the members that were new. Refresh the set's expiry. */
export const addMembersScript =
  "local added={} for i=2,#ARGV do if redis.call('SADD',KEYS[1],ARGV[i])==1 then added[#added+1]=ARGV[i] end end redis.call('EXPIRE',KEYS[1],tonumber(ARGV[1])) return added";

export function memberChunks(members: readonly string[], size = 1000): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < members.length; start += size)
    chunks.push(members.slice(start, start + size));
  return chunks;
}
