import * as z from 'zod';
import { googleCustomerIdSchema } from './google-connection';
import { deviceSyncFailureSchema } from './devices';
import { googleHealthFailureSchema } from './google-health';
import { jobDisplayIdSchema } from './jobs';

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
/** A Google `schemaId` or `fieldId`. It stays an opaque string, whatever characters it holds (C8). */
const googleSchemaId = z.string().min(1).max(200);
const etag = z.string().min(1).max(200);
/** The digest form of the device previews. A category plan freezes the same way (B section 6). */
const manifestDigest = z.string().regex(/^[a-f0-9]{64}$/);

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

/**
 * The users feed events of document A section 8. The feed drops the job ID, the batch counters,
 * the job record, the requester, and every failure that the caller cannot see, as the device feed
 * does. Every event names the entity type `user` (A section 15.4).
 */
export const userStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('entity-batch'),
    entityType: z.literal('user'),
    userIds: z.array(userId).max(1000),
    removedIds: z.array(userId).max(1000),
  }),
  z.strictObject({
    type: z.literal('job-finished'),
    entityType: z.literal('user'),
    failure: deviceSyncFailureSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('user-full-sync'),
    entityType: z.literal('user'),
    sync: userSyncStateSchema,
  }),
]);
export type UserStreamEvent = z.infer<typeof userStreamEventSchema>;

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
  fieldId: googleSchemaId,
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
  schemaId: googleSchemaId,
  schemaName: attributeText,
  displayName,
  etag,
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

/** The three category changes of the editor (B section 6.1). A plan kind is also its job action. */
export const userAttributeCategoryPlanKindSchema = z.enum([
  'create-category',
  'edit-category',
  'delete-category',
]);
export type UserAttributeCategoryPlanKind = z.infer<
  typeof userAttributeCategoryPlanKindSchema
>;

/** The one Google call of each plan kind. One save gives one plan and one call (B section 6.1). */
export const USER_ATTRIBUTE_CATEGORY_PLAN_METHODS: Readonly<
  Record<UserAttributeCategoryPlanKind, 'insert' | 'update' | 'delete'>
> = {
  'create-category': 'insert',
  'edit-category': 'update',
  'delete-category': 'delete',
};

/** The properties that an edit changes on a kept attribute (B section 5). A name and an info type
 * are locked, so they never appear here. */
export const userAttributeCategoryPlanPropertySchema = z.enum([
  'displayName',
  'multiValued',
  'indexed',
  'readAccessType',
  'numericIndexingSpec',
]);
export type UserAttributeCategoryPlanProperty = z.infer<
  typeof userAttributeCategoryPlanPropertySchema
>;

/**
 * One attribute of a category draft (B sections 5 and 6.1). A kept attribute carries its cached
 * field ID, and a new attribute carries null. An edit copies every property of a kept field from
 * the schema cache, the number range included (C3).
 */
export const userAttributeCategoryDraftFieldSchema = z
  .strictObject({
    fieldId: googleSchemaId.nullable(),
    fieldName: attributeText,
    displayName,
    fieldType: userAttributeFieldTypeSchema,
    multiValued: z.boolean(),
    indexed: z.boolean(),
    readAccessType: userAttributeVisibilitySchema,
    /** The optional range of a whole-number or a decimal attribute (K19, B section 5). */
    numericIndexingSpec: userAttributeRangeSchema.nullable(),
  })
  .refine(
    (field) =>
      field.numericIndexingSpec === null ||
      field.fieldType === 'INT64' ||
      field.fieldType === 'DOUBLE',
    { message: 'A number range belongs to a number attribute.' },
  );
export type UserAttributeCategoryDraftField = z.infer<
  typeof userAttributeCategoryDraftFieldSchema
>;

/** A create draft: the new category name and its attributes. Google assigns every field ID. */
export const userAttributeCategoryCreateDraftSchema = z
  .strictObject({
    schemaName: attributeText,
    displayName,
    fields: z
      .array(userAttributeCategoryDraftFieldSchema)
      .min(1)
      .max(USER_ATTRIBUTE_FIELD_LIMIT),
  })
  .refine((draft) => draft.fields.every((field) => field.fieldId === null), {
    message: 'A new attribute carries no field ID.',
  });
export type UserAttributeCategoryCreateDraft = z.infer<
  typeof userAttributeCategoryCreateDraftSchema
>;

/** An edit draft: the category label and every attribute that the save keeps or adds. A cached
 * schema name never changes (B section 5). */
export const userAttributeCategoryEditDraftSchema = z.strictObject({
  displayName,
  fields: z
    .array(userAttributeCategoryDraftFieldSchema)
    .min(1)
    .max(USER_ATTRIBUTE_FIELD_LIMIT),
});
export type UserAttributeCategoryEditDraft = z.infer<
  typeof userAttributeCategoryEditDraftSchema
>;

/**
 * The plan request of B section 10: `{ kind, schemaId?, baseEtag?, draft }`. A create names a new
 * category. An edit and a delete name the cached category and the `etag` that the plan compares.
 * The `schemaId` stays an opaque string (C8).
 */
export const userAttributeCategoryPlanRequestSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('create-category'),
      draft: userAttributeCategoryCreateDraftSchema,
    }),
    z.strictObject({
      kind: z.literal('edit-category'),
      schemaId: googleSchemaId,
      baseEtag: etag,
      draft: userAttributeCategoryEditDraftSchema,
    }),
    z.strictObject({
      kind: z.literal('delete-category'),
      schemaId: googleSchemaId,
      baseEtag: etag,
    }),
  ],
);
export type UserAttributeCategoryPlanRequest = z.infer<
  typeof userAttributeCategoryPlanRequestSchema
>;

/** One attribute change of a plan (B section 6.1). A removed attribute carries its holder count,
 * and a changed one names the properties that move. */
export const userAttributeCategoryPlanChangeSchema = z
  .strictObject({
    change: z.enum(['added', 'changed', 'removed']),
    fieldId: googleSchemaId.nullable(),
    fieldName: attributeText,
    displayName,
    properties: z.array(userAttributeCategoryPlanPropertySchema).max(5),
    holders: count.nullable(),
  })
  .refine(
    (change) => (change.fieldId === null) === (change.change === 'added'),
    {
      message: 'An added attribute has no ID, and another change names one.',
    },
  )
  .refine(
    (change) => change.change === 'changed' || change.properties.length === 0,
    {
      message: 'Only a changed attribute names a property.',
    },
  )
  .refine(
    (change) => change.change !== 'changed' || change.properties.length > 0,
    {
      message: 'A changed attribute names at least one property.',
    },
  )
  .refine(
    (change) => change.change !== 'removed' || change.properties.length === 0,
    {
      message: 'A removed attribute names no property.',
    },
  )
  .refine(
    (change) => (change.holders !== null) === (change.change === 'removed'),
    { message: 'A removed attribute carries its holder count.' },
  )
  .refine(
    (change) => new Set(change.properties).size === change.properties.length,
    { message: 'A property occurs once.' },
  );
export type UserAttributeCategoryPlanChange = z.infer<
  typeof userAttributeCategoryPlanChangeSchema
>;

/**
 * The plan answer of B section 10: the Google method, each change, the phrase to type, the two
 * limit counts after the save, the expiry, and the digest.
 */
export const userAttributeCategoryPlanSchema = z
  .strictObject({
    planId: z.uuid(),
    kind: userAttributeCategoryPlanKindSchema,
    method: z.enum(['insert', 'update', 'delete']),
    /** The cached category. A create carries null, because Google assigns the ID. */
    schemaId: googleSchemaId.nullable(),
    schemaName: attributeText,
    /** The category label that the plan writes, or the cached label on a delete. */
    displayName,
    /** The cached `etag` that the plan compares before it writes. A create carries none. */
    baseEtag: etag.nullable(),
    /** A save removes and adds attributes, so a plan holds up to twice the field limit. */
    changes: z
      .array(userAttributeCategoryPlanChangeSchema)
      .max(USER_ATTRIBUTE_FIELD_LIMIT * 2),
    /** The phrase that the person types: an attribute name or the category display name. */
    phrase: z.string().min(1).max(200).nullable(),
    /** The two limit counts after the save (B section 5). */
    limits: userAttributeLimitsSchema,
    preparedAt: timestamp,
    expiresAt: timestamp,
    digest: manifestDigest,
  })
  .refine(
    (plan) => plan.method === USER_ATTRIBUTE_CATEGORY_PLAN_METHODS[plan.kind],
    {
      message: 'The Google method follows the plan kind.',
    },
  )
  .refine((plan) => Date.parse(plan.expiresAt) > Date.parse(plan.preparedAt), {
    message: 'A plan expires after it was prepared.',
  })
  .refine(
    (plan) => (plan.schemaId === null) === (plan.kind === 'create-category'),
    { message: 'A create plan names no cached category.' },
  )
  .refine(
    (plan) => (plan.baseEtag === null) === (plan.kind === 'create-category'),
    { message: 'A create plan carries no cached etag.' },
  )
  .refine(
    (plan) =>
      plan.kind !== 'create-category' ||
      plan.changes.every((change) => change.change === 'added'),
    { message: 'A create plan adds attributes.' },
  )
  .refine(
    (plan) =>
      plan.kind !== 'delete-category' ||
      plan.changes.every((change) => change.change === 'removed'),
    { message: 'A delete plan removes attributes.' },
  )
  .refine(
    (plan) => plan.kind !== 'create-category' || plan.changes.length > 0,
    {
      message: 'A create plan adds one attribute.',
    },
  )
  .refine(
    (plan) =>
      (plan.phrase !== null) ===
      (plan.kind === 'delete-category' ||
        plan.changes.some((change) => change.change === 'removed')),
    { message: 'A removal and a delete require the typed phrase.' },
  );
export type UserAttributeCategoryPlan = z.infer<
  typeof userAttributeCategoryPlanSchema
>;

/** The confirm body of B section 10: `{ digest, acknowledged, typedPhrase? }`. The caller trims
 * the phrase. */
export const userAttributeCategoryPlanConfirmRequestSchema = z.strictObject({
  digest: manifestDigest,
  acknowledged: z.literal(true),
  typedPhrase: z.string().min(1).max(200).optional(),
});
export type UserAttributeCategoryPlanConfirmRequest = z.infer<
  typeof userAttributeCategoryPlanConfirmRequestSchema
>;

/** The receipt of a category plan confirm. It names the `CAT-` job and its change count. */
export const userAttributeCategoryJobReceiptSchema = z
  .strictObject({
    jobId: z.uuid(),
    displayId: jobDisplayIdSchema,
    status: z.literal('accepted'),
    action: userAttributeCategoryPlanKindSchema,
    changeCount: count,
  })
  .refine((receipt) => receipt.displayId.startsWith('CAT-'), {
    message: 'A category job carries a CAT display ID.',
  });
export type UserAttributeCategoryJobReceipt = z.infer<
  typeof userAttributeCategoryJobReceiptSchema
>;
