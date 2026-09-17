import { z } from 'zod';

const customerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ouId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
export const SCHOOL_REFERENCE_MAX_AGE_MS = 10 * 60 * 1000;
export const ouReferenceSchema = z.strictObject({
  id: ouId,
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(4096),
  parentId: ouId.nullable(),
});
export const schoolReferenceObservationSchema = z.strictObject({
  customerId,
  generation: z.number().int().positive(),
  revision: z.uuid(),
  observedAt: z.iso.datetime(),
  verified: z.literal(true),
  complete: z.literal(true),
  units: z.array(ouReferenceSchema).min(1).max(10000),
});
const schoolReferenceRuleSchema = z.strictObject({
  id: ouId,
  descendants: z.boolean(),
});
export const schoolScopeRulesSchema = z
  .strictObject({
    include: z.array(schoolReferenceRuleSchema).min(1).max(128),
    exclude: z.array(schoolReferenceRuleSchema).max(128),
  })
  .superRefine((rules, context) => {
    const ids = [...rules.include, ...rules.exclude].map((rule) => rule.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        message: 'Each OU can occur in only one inclusion or exclusion.',
      });
  });
export type SchoolReferenceObservation = z.infer<
  typeof schoolReferenceObservationSchema
>;
export type SchoolScopeRules = z.infer<typeof schoolScopeRulesSchema>;
type ScopeResult =
  | { valid: true; ids: string[] }
  | {
      valid: false;
      reason:
        | 'invalid-reference'
        | 'wrong-customer'
        | 'retired-generation'
        | 'stale-reference'
        | 'invalid-rules'
        | 'missing-reference'
        | 'empty-scope';
    };

/** Resolve only verified server observations. Browser input never establishes verification. */
export function resolveSchoolScope(input: {
  observation: unknown;
  rules: unknown;
  customerId: string;
  generation: number;
  now: number;
}): ScopeResult {
  const parsed = schoolReferenceObservationSchema.safeParse(input.observation);
  if (!parsed.success) return { valid: false, reason: 'invalid-reference' };
  const observation = parsed.data;
  if (observation.customerId !== input.customerId)
    return { valid: false, reason: 'wrong-customer' };
  if (observation.generation !== input.generation)
    return { valid: false, reason: 'retired-generation' };
  const age = input.now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < 0 || age >= SCHOOL_REFERENCE_MAX_AGE_MS)
    return { valid: false, reason: 'stale-reference' };
  const units = new Map(observation.units.map((unit) => [unit.id, unit]));
  const roots = observation.units.filter((unit) => unit.parentId === null);
  if (
    units.size !== observation.units.length ||
    roots.length !== 1 ||
    roots[0].path !== '/'
  )
    return { valid: false, reason: 'invalid-reference' };
  const paths = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  for (const unit of units.values()) {
    if (paths.has(unit.path))
      return { valid: false, reason: 'invalid-reference' };
    paths.add(unit.path);
    const seen = new Set([unit.id]);
    let current = unit;
    while (current.parentId !== null) {
      const parent = units.get(current.parentId);
      if (
        !parent ||
        seen.has(parent.id) ||
        seen.size > 35 ||
        current.name.includes('/') ||
        current.path !==
          `${parent.path === '/' ? '' : parent.path}/${current.name}`
      )
        return { valid: false, reason: 'invalid-reference' };
      seen.add(parent.id);
      current = parent;
    }
    ancestors.set(unit.id, seen);
  }
  const parsedRules = schoolScopeRulesSchema.safeParse(input.rules);
  if (!parsedRules.success) return { valid: false, reason: 'invalid-rules' };
  const rules = parsedRules.data;
  if ([...rules.include, ...rules.exclude].some((rule) => !units.has(rule.id)))
    return { valid: false, reason: 'missing-reference' };
  const matches = (
    id: string,
    rule: z.infer<typeof schoolReferenceRuleSchema>,
  ) => id === rule.id || (rule.descendants && ancestors.get(id)!.has(rule.id));
  const ids = [...units.keys()]
    .filter(
      (id) =>
        rules.include.some((rule) => matches(id, rule)) &&
        !rules.exclude.some((rule) => matches(id, rule)),
    )
    .sort();
  return ids.length
    ? { valid: true, ids }
    : { valid: false, reason: 'empty-scope' };
}

/** Hierarchy changes cannot add an identity absent from the confirmed set. */
export function effectiveSchoolScope(
  input: Parameters<typeof resolveSchoolScope>[0] & {
    approvedIds: unknown;
  },
): ScopeResult {
  const approved = z.array(ouId).min(1).max(10000).safeParse(input.approvedIds);
  if (!approved.success || new Set(approved.data).size !== approved.data.length)
    return { valid: false, reason: 'invalid-rules' };
  const result = resolveSchoolScope(input);
  if (!result.valid) return result;
  const allowed = new Set(approved.data);
  const ids = result.ids.filter((id) => allowed.has(id));
  return ids.length
    ? { valid: true, ids }
    : { valid: false, reason: 'empty-scope' };
}
