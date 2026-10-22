import * as z from 'zod';
import { googleFailureSchema } from './google-connection';

const orgUnitId = z.string().min(1).max(128);
/** The path rule of `ac/devices.ts:10`: a leading slash, 1 to 4,096 UTF-16 units. */
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');

/** One organization unit of the Google tree, in Google's casing. */
export const deviceOrgUnitTreeEntrySchema = z.strictObject({
  orgUnitId,
  name: z.string().min(1).max(256),
  orgUnitPath,
  /** The root unit has no parent, so its entry carries null. */
  parentOrgUnitId: orgUnitId.nullable(),
});
export type DeviceOrgUnitTreeEntry = z.infer<
  typeof deviceOrgUnitTreeEntrySchema
>;

/**
 * The three answers of the tree read (section 6). A read always ran, so the
 * write-access state `unchecked` never occurs here.
 */
export const deviceOrgUnitTreeStateSchema = z.enum([
  'granted',
  'denied',
  'unavailable',
]);
export type DeviceOrgUnitTreeState = z.infer<
  typeof deviceOrgUnitTreeStateSchema
>;

const deviceOrgUnitTreeShape = z.strictObject({
  state: deviceOrgUnitTreeStateSchema,
  /** The one scope that the read mints. */
  scope: z.string().min(1).max(512),
  failure: googleFailureSchema.nullable(),
  /** The whole tree while granted. Null in the other states. */
  orgUnits: z.array(deviceOrgUnitTreeEntrySchema).min(1).max(10000).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});

/** The answer of `GET /api/devices/updates/org-units`. */
export const deviceOrgUnitTreeSchema = deviceOrgUnitTreeShape
  .refine(
    (answer) => (answer.state === 'granted') === (answer.orgUnits !== null),
    { message: 'Only a granted answer carries the tree.' },
  )
  .refine(
    (answer) => (answer.state === 'granted') === (answer.failure === null),
    { message: 'Only a granted answer carries no failure.' },
  );
export type DeviceOrgUnitTree = z.infer<typeof deviceOrgUnitTreeSchema>;
