import * as z from 'zod';

export const actionSchema = z.enum([
  'customer:read',
  'customer:write',
  'connection:read',
  'connection:diagnose',
  'connection:manage',
  'platform-users:read',
  'platform-users:invite',
  'platform-users:manage',
  'schools:read',
  'schools:manage',
  'security-events:read',
]);
export type Action = z.infer<typeof actionSchema>;

const customerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const resourceScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({ kind: z.literal('district'), customerId }),
  z.strictObject({ kind: z.literal('school'), customerId, schoolId: z.uuid() }),
]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

/** A scope names a resource. It never proves that the resource exists. */
export const actionScopeKinds: Readonly<
  Record<Action, readonly ResourceScope['kind'][]>
> = {
  'customer:read': ['platform', 'district'],
  'customer:write': ['platform', 'district'],
  'connection:read': ['platform', 'district'],
  'connection:diagnose': ['platform', 'district'],
  'connection:manage': ['platform'],
  'platform-users:read': ['platform'],
  'platform-users:invite': ['platform'],
  'platform-users:manage': ['platform'],
  'schools:read': ['platform', 'district', 'school'],
  'schools:manage': ['platform', 'district'],
  'security-events:read': ['platform', 'district', 'school'],
};

export const grantSchema = z
  .strictObject({
    action: actionSchema,
    scope: resourceScopeSchema,
  })
  .refine(
    (grant) => actionScopeKinds[grant.action].includes(grant.scope.kind),
    {
      message: 'The action does not support this resource scope.',
    },
  );
export type Grant = z.infer<typeof grantSchema>;
export const grantsSchema = z.array(grantSchema).max(256);

/** Callers resolve existing, current resources before requesting authorization. */
export function isAuthorized(
  grants: readonly Grant[],
  action: Action,
  resource: ResourceScope,
): boolean {
  const requested = grantSchema.safeParse({ action, scope: resource });
  if (!requested.success) return false;
  return grants.some((candidate) => {
    const parsed = grantSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.action !== action) return false;
    const scope = parsed.data.scope;
    if (scope.kind === 'platform') return true;
    if (
      resource.kind === 'platform' ||
      scope.customerId !== resource.customerId
    )
      return false;
    if (scope.kind === 'district') return true;
    return resource.kind === 'school' && scope.schoolId === resource.schoolId;
  });
}

export const permissionPresetSchema = z.enum([
  'platform-administrator',
  'district-administrator',
  'school-administrator',
  'viewer',
]);
export type PermissionPreset = z.infer<typeof permissionPresetSchema>;

/** Presets expand to explicit grants. Authorization never evaluates preset names. */
export function grantsForPreset(
  preset: PermissionPreset,
  scope: ResourceScope,
): Grant[] {
  permissionPresetSchema.parse(preset);
  resourceScopeSchema.parse(scope);
  const actions: Record<PermissionPreset, readonly Action[]> = {
    'platform-administrator': actionSchema.options,
    'district-administrator': [
      'customer:read',
      'customer:write',
      'connection:read',
      'connection:diagnose',
      'schools:read',
      'schools:manage',
      'security-events:read',
    ],
    'school-administrator': ['schools:read', 'security-events:read'],
    viewer:
      scope.kind === 'school'
        ? ['schools:read']
        : ['customer:read', 'connection:read', 'schools:read'],
  };
  const expectedKind =
    preset === 'platform-administrator'
      ? 'platform'
      : preset === 'school-administrator'
        ? 'school'
        : 'district';
  if (
    scope.kind !== expectedKind &&
    !(preset === 'viewer' && scope.kind === 'school')
  )
    throw new Error(
      'The permission preset does not support this resource scope.',
    );
  return actions[preset].map((action) => grantSchema.parse({ action, scope }));
}
