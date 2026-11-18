import {
  userAttributeKey,
  userDetailSchema,
  userRowSchema,
  type UserDetail,
  type UserPredicate,
  type UserQuery,
  type UserRow,
} from '@campus/application-contracts';
import type { UserSelectionState } from './user-selection';

/** The status precedence of A section 15.4: Archived over Suspended over Active. */
const status =
  "CASE WHEN u.archived THEN 'archived' WHEN u.suspended THEN 'suspended' ELSE 'active' END";
const twoStep =
  "CASE WHEN u.two_step_enrolled THEN 'enrolled' ELSE 'not-enrolled' END";

const columns = {
  fullName: 'u.full_name',
  primaryEmail: 'u.primary_email',
  orgUnitPath: 'u.org_unit_path',
  status,
  lastLoginTime: 'u.last_login_time',
  creationTime: 'u.creation_time',
  department: 'u.department',
  title: 'u.title',
} as const;

/** The text fields, whose filters compare letter case without regard (A section 15.4). */
const textColumns = {
  fullName: columns.fullName,
  primaryEmail: columns.primaryEmail,
  department: columns.department,
  title: columns.title,
} as const;

const from =
  'FROM cc.user_sync_state s JOIN cc.users u ON u.customer_id=s.customer_id';

export const userColumns = `u.user_id,u.primary_email,u.org_unit_path,u.given_name,u.family_name,u.full_name,u.suspended,u.suspension_reason,u.archived,u.last_login_time,u.creation_time,u.two_step_enrolled,u.department,u.title,u.aliases,u.custom_schemas,u.last_entity_sync,u.removed_at,u.record_version`;

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

type Add = (value: unknown) => string;

function adder(values: unknown[]): Add {
  return (value) => {
    values.push(value);
    return `$${values.length}`;
  };
}

/**
 * The JSON path of one attribute predicate. C1 gives one ID for one attribute, and the one
 * builder names it (design section 1). A schema name and a field name hold no dot, so the key
 * splits without ambiguity.
 */
function attributePath(predicate: { schemaName: string; fieldName: string }) {
  return userAttributeKey(predicate.schemaName, predicate.fieldName)
    .slice('attr:'.length)
    .split('.');
}

/**
 * One attribute predicate. A multi-value attribute matches when any entry matches (A section
 * 15.4). The operators follow the info type (baseline default 4).
 */
function attributeClause(
  predicate: Extract<UserPredicate, { field: 'attribute' }>,
  add: Add,
): string {
  const value = `u.custom_schemas #> ${add(attributePath(predicate))}::text[]`;
  if (predicate.operator === 'contains')
    return `EXISTS(SELECT 1 FROM unnest(cc.user_attribute_values(${value})) v WHERE v ILIKE ${add(`%${escapeLike(predicate.value)}%`)})`;
  if (predicate.operator === 'numberRange')
    return `EXISTS(SELECT 1 FROM unnest(cc.user_attribute_numbers(${value})) n WHERE n BETWEEN cc.user_attribute_number(${add(String(predicate.from))}) AND cc.user_attribute_number(${add(String(predicate.to))}))`;
  if (predicate.operator === 'dateRange')
    return `EXISTS(SELECT 1 FROM unnest(cc.user_attribute_values(${value})) v WHERE v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND v BETWEEN ${add(predicate.from)} AND ${add(predicate.to)})`;
  if (predicate.operator === 'is')
    return `EXISTS(SELECT 1 FROM unnest(cc.user_attribute_values(${value})) v WHERE lower(v)=${add(String(predicate.value))})`;
  return `cc.user_attribute_has_value(${value})`;
}

/** Field names map to fixed columns. Values travel only as parameters. */
function predicateClauses(
  predicates: readonly UserPredicate[],
  add: Add,
): string[] {
  const clauses: string[] = [];
  for (const predicate of predicates) {
    if (predicate.field === 'attribute') {
      clauses.push(attributeClause(predicate, add));
    } else if (predicate.field === 'orgUnitPath') {
      clauses.push(`u.org_unit_path=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'status') {
      clauses.push(`${status}=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'twoStep') {
      clauses.push(`${twoStep}=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'aliases') {
      if (predicate.operator === 'isEmpty')
        clauses.push('jsonb_array_length(u.aliases)=0');
      else if (predicate.operator === 'equals')
        clauses.push(
          `EXISTS(SELECT 1 FROM jsonb_array_elements_text(u.aliases) a WHERE lower(a)=lower(${add(predicate.value)}))`,
        );
      else
        clauses.push(
          `EXISTS(SELECT 1 FROM jsonb_array_elements_text(u.aliases) a WHERE a ILIKE ${add(`%${escapeLike(predicate.value)}%`)})`,
        );
    } else if (
      predicate.field === 'lastLoginTime' ||
      predicate.field === 'creationTime'
    ) {
      clauses.push(
        `u.${predicate.field === 'lastLoginTime' ? 'last_login_time' : 'creation_time'} ${predicate.operator === 'before' ? '<' : '>='} ${add(predicate.value)}::timestamptz`,
      );
    } else {
      const column = textColumns[predicate.field];
      if (predicate.operator === 'isEmpty')
        clauses.push(`(${column} IS NULL OR ${column}='')`);
      else if (predicate.operator === 'equals')
        clauses.push(`lower(${column})=lower(${add(predicate.value)})`);
      else
        clauses.push(
          `${column} ILIKE ${add(
            predicate.operator === 'contains'
              ? `%${escapeLike(predicate.value)}%`
              : `${escapeLike(predicate.value)}%`,
          )}`,
        );
    }
  }
  return clauses;
}

/** Selected users: any filter term or explicit addition, minus exceptions. */
function selectedClause(state: UserSelectionState, add: Add): string {
  const all = (clauses: string[]) =>
    clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
  const parts = [
    ...state.terms.map((term) => all(predicateClauses(term, add))),
  ];
  if (state.additions.length)
    parts.push(`u.user_id=ANY(${add(state.additions)}::text[])`);
  if (!parts.length) return 'FALSE';
  const chosen = `(${parts.join(' OR ')})`;
  return state.exceptions.length
    ? `(${chosen} AND NOT u.user_id=ANY(${add(state.exceptions)}::text[]))`
    : chosen;
}

function userWhere(
  predicates: readonly UserPredicate[],
  values: unknown[],
  selection: UserSelectionState | null = null,
): string {
  const add = adder(values);
  const clauses = [
    's.customer_id=$1',
    'u.removed_at IS NULL',
    ...predicateClauses(predicates, add),
  ];
  if (selection) clauses.push(selectedClause(selection, add));
  return clauses.join(' AND ');
}

/** The grid order: the sort column with nulls last, then the user ID in the same direction. */
function orderBy(sort: UserQuery['sort']): string {
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${columns[sort.field]} ${direction} NULLS LAST,u.user_id ${direction}`;
}

export function userPageSql(
  customerId: string,
  query: UserQuery,
  selection: UserSelectionState | null = null,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = userWhere(query.predicates, values, selection);
  return {
    rows: {
      text: `SELECT ${userColumns} ${from} WHERE ${where} ${orderBy(query.sort)} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}

/** Every stale user in the result set, not only the page. The API refreshes them all. */
export function staleIdsSql(
  customerId: string,
  query: UserQuery,
  selection: UserSelectionState | null,
  cutoff: Date,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = userWhere(query.predicates, values, selection);
  values.push(cutoff.toISOString());
  return {
    text: `SELECT u.user_id ${from} WHERE ${where} AND u.last_entity_sync<$${values.length}::timestamptz ORDER BY u.user_id LIMIT 100000`,
    values,
  };
}

/** Every user ID of a result set in grid order. The query cache stores this list (D2). */
export function userIdsSql(
  customerId: string,
  query: UserQuery,
  limit: number,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = userWhere(query.predicates, values);
  values.push(limit);
  return {
    text: `SELECT u.user_id ${from} WHERE ${where} ${orderBy(query.sort)} LIMIT $${values.length}`,
    values,
  };
}

export interface UserEntryRef {
  userId: string;
  version: number | null;
}

/**
 * One row for every known user. Each row carries the current entry version.
 * The record columns stay null when the supplied entry version is current.
 * A removed user stays in the result, because a cached list holds it until it expires.
 */
export function userRowsByIdSql(
  customerId: string,
  entries: readonly UserEntryRef[],
): SqlStatement {
  const changed =
    'requested.version IS NULL OR requested.version IS DISTINCT FROM u.record_version';
  const conditional = (expression: string, alias: string) =>
    `CASE WHEN ${changed} THEN ${expression} END AS ${alias}`;
  const list = [
    ['u.primary_email', 'primary_email'],
    ['u.org_unit_path', 'org_unit_path'],
    ['u.given_name', 'given_name'],
    ['u.family_name', 'family_name'],
    ['u.full_name', 'full_name'],
    ['u.suspended', 'suspended'],
    ['u.suspension_reason', 'suspension_reason'],
    ['u.archived', 'archived'],
    ['u.last_login_time', 'last_login_time'],
    ['u.creation_time', 'creation_time'],
    ['u.two_step_enrolled', 'two_step_enrolled'],
    ['u.department', 'department'],
    ['u.title', 'title'],
    ['u.aliases', 'aliases'],
    ['u.custom_schemas', 'custom_schemas'],
    ['u.last_entity_sync', 'last_entity_sync'],
    ['u.removed_at', 'removed_at'],
  ]
    .map(([expression, alias]) => conditional(expression, alias))
    .join(',');
  return {
    text: `SELECT u.user_id AS user_id,u.record_version AS entry_version,u.record_version AS record_version,${list} ${from} JOIN unnest($2::text[],$3::bigint[]) AS requested(user_id,version) ON requested.user_id=u.user_id WHERE s.customer_id=$1`,
    values: [
      customerId,
      entries.map((entry) => entry.userId),
      entries.map((entry) => entry.version),
    ],
  };
}

/** The number of stale users in a result set. The banner reports it (D11). */
export function staleCountSql(
  customerId: string,
  query: UserQuery,
  selection: UserSelectionState | null,
  cutoff: Date,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = userWhere(query.predicates, values, selection);
  values.push(cutoff.toISOString());
  return {
    text: `SELECT count(*)::integer AS stale ${from} WHERE ${where} AND u.last_entity_sync<$${values.length}::timestamptz`,
    values,
  };
}

/** Whether a user refresh job runs for the customer. The job reaper interrupts jobs after two hours. */
export function refreshingSql(customerId: string): SqlStatement {
  return {
    text: "SELECT EXISTS(SELECT 1 FROM cc.entity_sync_jobs WHERE customer_id=$1 AND entity_type='user' AND finished_at IS NULL AND created_at>clock_timestamp()-interval '2 hours') AS refreshing",
    values: [customerId],
  };
}

export function userDetailSql(
  customerId: string,
  userId: string,
): SqlStatement {
  return {
    text: `SELECT ${userColumns} ${from} WHERE s.customer_id=$1 AND u.user_id=$2`,
    values: [customerId, userId],
  };
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value ?? null);

export function userRow(row: Record<string, unknown>, cutoff: number): UserRow {
  const lastEntitySync = iso(row['last_entity_sync']);
  return userRowSchema.parse({
    userId: row['user_id'],
    primaryEmail: row['primary_email'],
    orgUnitPath: row['org_unit_path'],
    givenName: row['given_name'],
    familyName: row['family_name'],
    fullName: row['full_name'],
    suspended: row['suspended'],
    suspensionReason: row['suspension_reason'],
    archived: row['archived'],
    lastLoginTime: iso(row['last_login_time']),
    creationTime: iso(row['creation_time']),
    twoStepEnrolled: row['two_step_enrolled'],
    department: row['department'],
    title: row['title'],
    aliases: row['aliases'] ?? [],
    customSchemas: row['custom_schemas'] ?? {},
    lastEntitySync,
    stale:
      !row['removed_at'] &&
      typeof lastEntitySync === 'string' &&
      Date.parse(lastEntitySync) < cutoff,
    recordVersion: Number(row['record_version']),
  });
}

export function userDetail(
  row: Record<string, unknown>,
  cutoff: number,
): UserDetail {
  return userDetailSchema.parse({
    ...userRow(row, cutoff),
    removedAt: iso(row['removed_at']),
  });
}

export function userOrgUnitsSql(customerId: string): SqlStatement {
  return {
    text: `SELECT u.org_unit_path,count(*)::integer AS users ${from} WHERE s.customer_id=$1 AND u.removed_at IS NULL GROUP BY u.org_unit_path ORDER BY u.org_unit_path LIMIT 10000`,
    values: [customerId],
  };
}

export function selectionCountSql(
  customerId: string,
  selection: UserSelectionState,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = userWhere([], values, selection);
  return {
    text: `SELECT count(*)::integer AS selected ${from} WHERE ${where}`,
    values,
  };
}

/**
 * Every selected user with the stamp of a refresh. Filter terms skip removed users. An explicit
 * addition keeps a removed user, so Refresh Selected can leave it out of the job.
 */
export function selectionIdsSql(
  customerId: string,
  selection: UserSelectionState,
  limit = 100_001,
): SqlStatement {
  const values: unknown[] = [customerId];
  const add = adder(values);
  const all = (clauses: string[]) =>
    clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
  const parts = [
    ...selection.terms.map((term) =>
      all(['u.removed_at IS NULL', ...predicateClauses(term, add)]),
    ),
  ];
  if (selection.additions.length)
    parts.push(`u.user_id=ANY(${add(selection.additions)}::text[])`);
  const chosen = parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
  const exceptions = selection.exceptions.length
    ? ` AND NOT u.user_id=ANY(${add(selection.exceptions)}::text[])`
    : '';
  values.push(limit);
  return {
    text: `SELECT u.user_id,u.removed_at ${from} WHERE s.customer_id=$1 AND ${chosen}${exceptions} ORDER BY u.user_id LIMIT $${values.length}`,
    values,
  };
}

/** Which of the given users match a filter. */
export function matchingAmongSql(
  customerId: string,
  predicates: readonly UserPredicate[],
  ids: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = userWhere(predicates, values);
  return {
    text: `SELECT u.user_id ${from} WHERE ${where} AND u.user_id=ANY($2::text[])`,
    values,
  };
}

/** Which of the given users the selection holds. */
export function selectedAmongSql(
  customerId: string,
  selection: UserSelectionState,
  ids: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = userWhere([], values, selection);
  return {
    text: `SELECT u.user_id ${from} WHERE ${where} AND u.user_id=ANY($2::text[])`,
    values,
  };
}
