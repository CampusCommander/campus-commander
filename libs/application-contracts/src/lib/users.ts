import * as z from 'zod';
import { googleCustomerIdSchema } from './google-connection';
import { deviceSyncFailureSchema } from './devices';
import { googleHealthFailureSchema } from './google-health';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);
const userId = z.string().min(1).max(128);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const filterText = z.string().trim().min(1).max(256);
/** A Google schema name or field name: letters, digits, `_`, and `-` (B section 5). */
const attributeNameSource = '[A-Za-z0-9_-]{1,200}';
const attributeName = new RegExp(`^${attributeNameSource}$`);
const attributeText = z.string().regex(attributeName);
const displayName = z.string().min(1).max(200);
const recordVersion = z.number().int().min(1);

/**
 * C1: the one ID of one attribute. The grid uses it as its column ID, the filter panel as the key
 * of its chip and predicate, and the draft store as the key of its draft (design section 1).
 * The form is `attr:<schemaName>.<fieldName>`, after the Google query form (B section 12, E13).
 */
export function userAttributeKey(
  schemaName: string,
  fieldName: string,
): string {
  if (!attributeName.test(schemaName) || !attributeName.test(fieldName))
    throw new Error('An attribute name holds letters, digits, _ and - only.');
  return `attr:${schemaName}.${fieldName}`;
}

/** The C1 ID of one attribute, as the client and the API read it. */
export const userAttributeKeySchema = z
  .string()
  .regex(new RegExp(`^attr:${attributeNameSource}\\.${attributeNameSource}$`));
export type UserAttributeKey = z.infer<typeof userAttributeKeySchema>;

/**
 * A JSON dictionary that keeps every own key, including `__proto__`.
 * Zod's record drops an own `__proto__` key, so this schema validates each value
 * and rebuilds the object with own data properties. The object prototype stays
 * unchanged.
 */
export function jsonDictionarySchema<V extends z.ZodType>(
  valueSchema: V,
): z.ZodType<Record<string, z.output<V>>, unknown> {
  return z.unknown().transform((input, ctx) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      ctx.addIssue({ code: 'custom', message: 'Expected a JSON object.' });
      return z.NEVER;
    }
    const output: Record<string, z.output<V>> = {};
    for (const key of Object.keys(input)) {
      const parsed = valueSchema.safeParse(
        (input as Record<string, unknown>)[key],
      );
      if (!parsed.success) {
        for (const issue of parsed.error.issues)
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: [key, ...issue.path],
          });
        continue;
      }
      Object.defineProperty(output, key, {
        value: parsed.data,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  });
}

/** The raw `customSchemas` object of one user, stored and served unchanged (A section 5.1). */
export const userCustomSchemasSchema = jsonDictionarySchema(
  jsonDictionarySchema(z.json()),
);
export type UserCustomSchemas = z.infer<typeof userCustomSchemasSchema>;

const recordShape = {
  userId,
  primaryEmail: z.email().max(254),
  orgUnitPath,
  givenName: z.string().max(256).nullable(),
  familyName: z.string().max(256).nullable(),
  fullName: z.string().max(4096).nullable(),
  suspended: z.boolean(),
  suspensionReason: z.string().max(4096).nullable(),
  archived: z.boolean(),
  lastLoginTime: timestamp.nullable(),
  creationTime: timestamp.nullable(),
  twoStepEnrolled: z.boolean(),
  department: z.string().max(4096).nullable(),
  title: z.string().max(4096).nullable(),
  aliases: z.array(z.email().max(254)).max(1000),
  customSchemas: userCustomSchemasSchema,
};

/** One user as the Google reader returns it. The cache adds `lastEntitySync`. */
export const userObservationSchema = z.strictObject(recordShape);
export type UserObservation = z.infer<typeof userObservationSchema>;

/** One user as Redis stores it. Readers add `stale` at read time. */
export const userRecordSchema = z.strictObject({
  ...recordShape,
  /** When Campus Commander last read this user from Google. */
  lastEntitySync: timestamp,
});
export type UserRecord = z.infer<typeof userRecordSchema>;

/** One grid row: the record, its freshness, and the version that a write reports (A section 8). */
export const userRowSchema = z.strictObject({
  ...recordShape,
  lastEntitySync: timestamp,
  stale: z.boolean(),
  recordVersion,
});
export type UserRow = z.infer<typeof userRowSchema>;

/** One user as the details page reads it. A removed user keeps its row and names its removal. */
export const userDetailSchema = z.strictObject({
  ...recordShape,
  lastEntitySync: timestamp,
  stale: z.boolean(),
  removedAt: timestamp.nullable(),
  recordVersion,
});
export type UserDetail = z.infer<typeof userDetailSchema>;

/** The status of one user: Archived over Suspended over Active (A section 15.4). */
export const userStatusSchema = z.enum(['active', 'suspended', 'archived']);
export type UserStatus = z.infer<typeof userStatusSchema>;
export const userTwoStepSchema = z.enum(['enrolled', 'not-enrolled']);
export type UserTwoStep = z.infer<typeof userTwoStepSchema>;
export const userSortFieldSchema = z.enum([
  'fullName',
  'primaryEmail',
  'orgUnitPath',
  'status',
  'lastLoginTime',
  'creationTime',
  'department',
  'title',
]);
export type UserSortField = z.infer<typeof userSortFieldSchema>;

/** Each attribute operator follows one info type (baseline default 4). */
export const userAttributeOperatorSchema = z.enum([
  'contains',
  'numberRange',
  'dateRange',
  'is',
  'hasValue',
]);
export type UserAttributeOperator = z.infer<typeof userAttributeOperatorSchema>;

const attributeShape = {
  field: z.literal('attribute'),
  schemaName: attributeText,
  fieldName: attributeText,
};

/** One attribute predicate. It names the category, the attribute, and its value (A section 8). */
export const userAttributePredicateSchema = z.union([
  z.strictObject({
    ...attributeShape,
    operator: z.literal('contains'),
    value: filterText,
  }),
  z
    .strictObject({
      ...attributeShape,
      operator: z.literal('numberRange'),
      from: z.number(),
      to: z.number(),
    })
    .refine((range) => range.from <= range.to, {
      message: 'A number range starts at or below its end.',
    }),
  z
    .strictObject({
      ...attributeShape,
      operator: z.literal('dateRange'),
      from: z.iso.date(),
      to: z.iso.date(),
    })
    .refine((range) => range.from <= range.to, {
      message: 'A date range starts at or below its end.',
    }),
  z.strictObject({
    ...attributeShape,
    operator: z.literal('is'),
    value: z.boolean(),
  }),
  z.strictObject({ ...attributeShape, operator: z.literal('hasValue') }),
]);
export type UserAttributePredicate = z.infer<
  typeof userAttributePredicateSchema
>;

const textField = z.enum(['fullName', 'primaryEmail', 'department', 'title']);
const textOperator = z.enum(['contains', 'startsWith', 'equals']);

/** Each field type offers only its own operators, and chips combine with AND (A section 8). */
export const userPredicateSchema = z.union([
  z.strictObject({
    field: textField,
    operator: textOperator,
    value: filterText,
  }),
  z.strictObject({ field: textField, operator: z.literal('isEmpty') }),
  z.strictObject({
    field: z.literal('aliases'),
    operator: z.enum(['contains', 'equals']),
    value: filterText,
  }),
  z.strictObject({
    field: z.literal('aliases'),
    operator: z.literal('isEmpty'),
  }),
  z.strictObject({
    field: z.literal('orgUnitPath'),
    operator: z.literal('in'),
    values: z.array(orgUnitPath).max(1000),
  }),
  z.strictObject({
    field: z.literal('status'),
    operator: z.literal('is'),
    values: z.array(userStatusSchema).max(3),
  }),
  z.strictObject({
    field: z.literal('twoStep'),
    operator: z.literal('is'),
    values: z.array(userTwoStepSchema).max(2),
  }),
  z.strictObject({
    field: z.literal('lastLoginTime'),
    operator: z.enum(['before', 'after']),
    value: timestamp,
  }),
  z.strictObject({
    field: z.literal('creationTime'),
    operator: z.enum(['before', 'after']),
    value: timestamp,
  }),
  userAttributePredicateSchema,
]);
export type UserPredicate = z.infer<typeof userPredicateSchema>;

/** One browser tab's selection in the Users grid. The API scopes it to the signed-in person. */
export const userSelectionKeySchema = z.strictObject({
  gridId: z.literal('users'),
  tabId: z.uuid(),
});
export type UserSelectionKey = z.infer<typeof userSelectionKeySchema>;

/** IDs per by-ids request. A grid holds at most 1,000 rows, so the client sends two requests. */
export const USER_BY_IDS_LIMIT = 500;
const selectionIds = z.array(userId).min(1).max(2000);

export const userSelectionOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('selectAll'),
    predicates: z.array(userPredicateSchema).max(20),
  }),
  z.strictObject({ op: z.literal('deselectAll') }),
  z.strictObject({ op: z.literal('select'), ids: selectionIds }),
  z.strictObject({ op: z.literal('deselect'), ids: selectionIds }),
]);
export type UserSelectionOp = z.infer<typeof userSelectionOpSchema>;

export const userSelectionChangeSchema = z.strictObject({
  gridId: z.literal('users'),
  tabId: z.uuid(),
  ops: z.array(userSelectionOpSchema).min(1).max(100),
});
export type UserSelectionChange = z.infer<typeof userSelectionChangeSchema>;

export const userSelectionResolveSchema = z.strictObject({
  gridId: z.literal('users'),
  tabId: z.uuid(),
  rowIds: z.array(userId).max(2000),
  /** The grid's filters, for a group row that the row IDs cannot answer. */
  predicates: z.array(userPredicateSchema).max(20).default([]),
});

/** What Select All captured and the API's count. User IDs stay on the server. */
export const userSelectionSpecSchema = z.strictObject({
  terms: z
    .array(
      z.strictObject({
        type: z.literal('all'),
        predicates: z.array(userPredicateSchema).max(20),
      }),
    )
    .max(50),
  added: count,
  excluded: count,
  selectedCount: count,
  /** The expiry time of a selection that lapsed, or null while the selection is current. */
  expiredAt: timestamp.nullable(),
});
export type UserSelectionSpec = z.infer<typeof userSelectionSpecSchema>;

/** The answer of Refresh Selected. `selected` counts the users the job reads. */
export const userSelectionRefreshSchema = z.strictObject({
  jobId: z.uuid().nullable(),
  selected: z.number().int().min(1).max(100_000),
});
export type UserSelectionRefresh = z.infer<typeof userSelectionRefreshSchema>;

export const userQuerySchema = z.strictObject({
  predicates: z.array(userPredicateSchema).max(20).default([]),
  sort: z
    .strictObject({
      field: userSortFieldSchema,
      direction: z.enum(['asc', 'desc']),
    })
    .default({ field: 'fullName', direction: 'asc' }),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
  /** Show All Selected limits the query to this tab's selection. */
  selection: userSelectionKeySchema.nullable().default(null),
});
export type UserQuery = z.output<typeof userQuerySchema>;

export const userPageSchema = z.strictObject({
  rows: z.array(userRowSchema).max(1000),
  matching: count,
  total: count,
  observedAt: timestamp.nullable(),
  /** The refresh job this page started for its stale users, when one started. */
  refreshJobId: z.uuid().nullable(),
});
export type UserPage = z.infer<typeof userPageSchema>;

export const userByIdsSchema = z.strictObject({
  userIds: z.array(userId).min(1).max(USER_BY_IDS_LIMIT),
});

/** The stale count of one result set and whether a refresh job runs for the customer (A section 8). */
export const userFreshnessSchema = z.strictObject({
  stale: count,
  refreshing: z.boolean(),
});
export type UserFreshness = z.infer<typeof userFreshnessSchema>;

/** The state of the user inventory. It copies the device state without the telemetry part. */
export const userSyncStateSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  status: z.enum(['never', 'running', 'ready', 'failed']),
  observedAt: timestamp.nullable(),
  userCount: count,
  failure: deviceSyncFailureSchema.nullable(),
  startedAt: timestamp.nullable(),
  checkedAt: timestamp.nullable(),
  stale: z.boolean(),
});
export type UserSyncState = z.infer<typeof userSyncStateSchema>;

/** The answer of Refresh Domain. The sync and the domain read report separately. */
const userDomainRefreshShape = z.strictObject({
  sync: userSyncStateSchema,
  domain: z.strictObject({
    status: z.enum(['refreshed', 'failed']),
    /** A passed check carries no reason. A failed check names its cause. */
    reason: z
      .union([googleHealthFailureSchema, z.enum(['busy', 'unavailable'])])
      .nullable(),
  }),
});
export const userDomainRefreshSchema = userDomainRefreshShape.refine(
  (answer: z.infer<typeof userDomainRefreshShape>) =>
    (answer.domain.reason === null) === (answer.domain.status === 'refreshed'),
  {
    message: 'A refreshed check carries no reason. A failed check names one.',
  },
);
export type UserDomainRefresh = z.infer<typeof userDomainRefreshSchema>;

export const userOrgUnitSchema = z.strictObject({
  path: orgUnitPath,
  users: count,
});
export type UserOrgUnit = z.infer<typeof userOrgUnitSchema>;
export const userOrgUnitsSchema = z.array(userOrgUnitSchema).max(10000);

/** The Google account holds at most 100 categories and 100 attributes (B section 5). */
export const USER_ATTRIBUTE_CATEGORY_LIMIT = 100;
export const USER_ATTRIBUTE_FIELD_LIMIT = 100;

/** The seven info types of an attribute (B section 8.1). */
export const userAttributeFieldTypeSchema = z.enum([
  'STRING',
  'INT64',
  'DOUBLE',
  'BOOL',
  'DATE',
  'EMAIL',
  'PHONE',
]);
export type UserAttributeFieldType = z.infer<
  typeof userAttributeFieldTypeSchema
>;
/** `readAccessType`: "Admins and the user" or "Everyone in the organization" (B section 3). */
export const userAttributeVisibilitySchema = z.enum([
  'ADMINS_AND_SELF',
  'ALL_DOMAIN_USERS',
]);
export type UserAttributeVisibility = z.infer<
  typeof userAttributeVisibilitySchema
>;

/** The optional range of a number attribute. Google treats it as indicative (B section 3). */
export const userAttributeRangeSchema = z.strictObject({
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
});
export type UserAttributeRange = z.infer<typeof userAttributeRangeSchema>;

/** One attribute of the cache: the Google metadata and the users that hold a value (B section 5). */
export const userAttributeFieldSchema = z.strictObject({
  fieldId: z.string().min(1).max(200),
  fieldName: attributeText,
  displayName,
  fieldType: userAttributeFieldTypeSchema,
  multiValued: z.boolean(),
  indexed: z.boolean(),
  readAccessType: userAttributeVisibilitySchema,
  numericIndexingSpec: userAttributeRangeSchema.nullable(),
  holders: count,
});
export type UserAttributeField = z.infer<typeof userAttributeFieldSchema>;

/** One category of the cache: its Google metadata, its attributes, and its holders (B section 9). */
export const userAttributeCategorySchema = z.strictObject({
  schemaId: z.string().min(1).max(200),
  schemaName: attributeText,
  displayName,
  etag: z.string().min(1).max(200),
  fields: z
    .array(userAttributeFieldSchema)
    .min(1)
    .max(USER_ATTRIBUTE_FIELD_LIMIT),
  holders: count,
  /** When Campus Commander last read the categories from Google. */
  readAt: timestamp.nullable(),
});
export type UserAttributeCategory = z.infer<typeof userAttributeCategorySchema>;

/** One attribute as the Google reader returns it. The cache adds the holder count. */
export const userAttributeFieldObservationSchema =
  userAttributeFieldSchema.omit({
    holders: true,
  });
export type UserAttributeFieldObservation = z.infer<
  typeof userAttributeFieldObservationSchema
>;

/**
 * One category as the Google reader returns it. The cache adds the holder counts
 * and the read time (B section 9). The `schemaId` stays an opaque string (C8).
 */
export const userAttributeCategoryObservationSchema =
  userAttributeCategorySchema
    .extend({
      fields: z
        .array(userAttributeFieldObservationSchema)
        .min(1)
        .max(USER_ATTRIBUTE_FIELD_LIMIT),
    })
    .omit({ holders: true, readAt: true });
export type UserAttributeCategoryObservation = z.infer<
  typeof userAttributeCategoryObservationSchema
>;

/** The two limit counts of the account, with the maximum of each (B section 5). */
export const userAttributeLimitsSchema = z.strictObject({
  categories: count,
  categoryLimit: z.number().int().positive(),
  attributes: count,
  attributeLimit: z.number().int().positive(),
});
export type UserAttributeLimits = z.infer<typeof userAttributeLimitsSchema>;

/** The category read of B section 10 row 1: the categories, the limit counts, and the cache time. */
export const userAttributeCategoriesSchema = z.strictObject({
  categories: z
    .array(userAttributeCategorySchema)
    .max(USER_ATTRIBUTE_CATEGORY_LIMIT),
  limits: userAttributeLimitsSchema,
  observedAt: timestamp.nullable(),
});
export type UserAttributeCategories = z.infer<
  typeof userAttributeCategoriesSchema
>;
