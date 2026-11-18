import type { FilterModel } from 'ag-grid-community';
import { z } from 'zod';
import {
  userPredicateSchema,
  type UserPredicate,
} from '@campus/application-contracts';
import {
  USER_FIELDS,
  attributeFor,
  dateInputToIso,
  dateInputValue,
  fieldFor,
  type UserAttributeColumn,
} from './user-fields';

/**
 * A set filter with no values matches nobody. The user query has no predicate for
 * "no value", so the grid shows the empty result itself (R6).
 */
export class EmptySetFilterError extends Error {}

const textModel = z.object({
  filterType: z.literal('text'),
  type: z.enum(['contains', 'startsWith', 'equals', 'blank']),
  filter: z.string().nullish(),
});
const dateModel = z.object({
  filterType: z.literal('date'),
  type: z.enum(['before', 'after', 'inRange', 'equals']),
  dateFrom: z.string().nullish(),
  dateTo: z.string().nullish(),
});
const numberModel = z.object({
  filterType: z.literal('number'),
  type: z.enum(['inRange', 'equals']),
  filter: z.number().nullish(),
  filterTo: z.number().nullish(),
});
const setModel = z.object({
  filterType: z.literal('set'),
  values: z.array(z.string()),
});

/** The date part of an AG Grid date filter value. */
function datePart(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function predicateFor(fieldId: string, model: unknown): unknown {
  if (fieldId.startsWith('attr:')) throw new Error('attribute');
  const field = fieldFor(fieldId);
  if (field.kind === 'text') {
    const text = textModel.parse(model);
    return text.type === 'blank'
      ? { field: field.id, operator: 'isEmpty' }
      : { field: field.id, operator: text.type, value: text.filter ?? '' };
  }
  if (field.kind === 'dateTime') {
    const date = dateModel.parse(model);
    return {
      field: field.id,
      operator: date.type === 'before' ? 'before' : 'after',
      value: dateInputToIso(datePart(date.dateFrom) ?? ''),
    };
  }
  const set = setModel.parse(model);
  return {
    field: field.id,
    // Organization units match the chosen subtrees. The other set filters match exact values.
    operator: field.kind === 'orgUnit' ? 'in' : 'is',
    values: set.values,
  };
}

/** One attribute predicate from the filter of its info type (baseline default 4). */
function attributePredicate(
  attribute: UserAttributeColumn,
  model: unknown,
): unknown {
  const field = {
    schemaName: attribute.schemaName,
    fieldName: attribute.fieldName,
  };
  if (
    attribute.field.fieldType === 'INT64' ||
    attribute.field.fieldType === 'DOUBLE'
  ) {
    const number = numberModel.parse(model);
    const from = number.filter ?? number.filterTo ?? 0;
    const to = number.type === 'equals' ? from : (number.filterTo ?? from);
    return { field: 'attribute', ...field, operator: 'numberRange', from, to };
  }
  if (attribute.field.fieldType === 'DATE') {
    const date = dateModel.parse(model);
    const from = datePart(date.dateFrom) ?? datePart(date.dateTo) ?? '';
    const to = date.type === 'inRange' ? (datePart(date.dateTo) ?? from) : from;
    return { field: 'attribute', ...field, operator: 'dateRange', from, to };
  }
  if (attribute.field.fieldType === 'BOOL') {
    const set = setModel.parse(model);
    const values = new Set(set.values);
    for (const value of values)
      if (value !== 'true' && value !== 'false')
        throw new Error(`The user query has no boolean value ${value}.`);
    // One value filters that value. Both values mean that the attribute is set.
    if (values.size === 1)
      return {
        field: 'attribute',
        ...field,
        operator: 'is',
        value: values.has('true'),
      };
    if (values.size === 2)
      return { field: 'attribute', ...field, operator: 'hasValue' };
    // The query cannot express "no value of this attribute matches". A set filter
    // with no values matches nobody, and the grid reports that itself (R6).
    throw new EmptySetFilterError(
      'The user query cannot match an empty boolean filter.',
    );
  }
  const text = textModel.parse(model);
  if (text.type === 'blank')
    return { field: 'attribute', ...field, operator: 'hasValue' };
  return {
    field: 'attribute',
    ...field,
    operator: 'contains',
    value: text.filter ?? '',
  };
}

/**
 * Translate the grid's column filters to user predicates in column order.
 * A model that the query cannot express throws, so the grid fails the load instead
 * of showing unfiltered rows.
 */
export function predicatesFromFilterModel(
  model: FilterModel | null | undefined,
  attributes: readonly UserAttributeColumn[] = [],
): UserPredicate[] {
  const entries: FilterModel = model ?? {};
  for (const id of Object.keys(entries)) {
    if (id.startsWith('attr:') && !attributeFor(attributes, id))
      throw new Error(`The user query has no filter for ${id}.`);
    if (
      !id.startsWith('attr:') &&
      !USER_FIELDS.some((field) => field.id === id)
    )
      throw new Error(`The user query has no filter for ${id}.`);
  }
  const staticPredicates = USER_FIELDS.flatMap((field) =>
    entries[field.id]
      ? [userPredicateSchema.parse(predicateFor(field.id, entries[field.id]))]
      : [],
  );
  const attributePredicates = attributes.flatMap((attribute) =>
    entries[attribute.id]
      ? [
          userPredicateSchema.parse(
            attributePredicate(attribute, entries[attribute.id]),
          ),
        ]
      : [],
  );
  return [...staticPredicates, ...attributePredicates];
}

/** The filter model that shows these predicates, keyed by column ID. */
export function filterModelFromPredicates(
  predicates: readonly UserPredicate[],
  attributes: readonly UserAttributeColumn[] = [],
): FilterModel {
  const model: FilterModel = {};
  const attributeModels: FilterModel = {};
  for (const predicate of predicates) {
    if (predicate.field === 'attribute') {
      const attribute = attributeFor(
        attributes,
        `attr:${predicate.schemaName}.${predicate.fieldName}`,
      );
      if (!attribute) continue;
      switch (predicate.operator) {
        case 'numberRange':
          attributeModels[attribute.id] = {
            filterType: 'number',
            type: 'inRange',
            filter: predicate.from,
            filterTo: predicate.to,
          };
          break;
        case 'dateRange':
          attributeModels[attribute.id] = {
            filterType: 'date',
            type: 'inRange',
            dateFrom: `${predicate.from} 00:00:00`,
            dateTo: `${predicate.to} 00:00:00`,
          };
          break;
        case 'is':
          attributeModels[attribute.id] = {
            filterType: 'set',
            values: [predicate.value ? 'true' : 'false'],
          };
          break;
        case 'contains':
          attributeModels[attribute.id] = {
            filterType: 'text',
            type: 'contains',
            filter: predicate.value,
          };
          break;
        case 'hasValue':
          // A grid filter cannot express has-a-value. The chip still holds it.
          break;
      }
      continue;
    }
    if (predicate.field === 'aliases') continue;
    if ('values' in predicate)
      model[predicate.field] = {
        filterType: 'set',
        values: [...predicate.values],
      };
    else if (
      predicate.field === 'lastLoginTime' ||
      predicate.field === 'creationTime'
    )
      model[predicate.field] = {
        filterType: 'date',
        type: predicate.operator,
        dateFrom: `${dateInputValue(predicate.value)} 00:00:00`,
        dateTo: null,
      };
    else if (predicate.operator === 'isEmpty')
      model[predicate.field] = { filterType: 'text', type: 'blank' };
    else
      model[predicate.field] = {
        filterType: 'text',
        type: predicate.operator,
        filter: predicate.value,
      };
  }
  return { ...model, ...attributeModels };
}

/**
 * The field that a predicate filters. The store keeps one predicate for each field.
 * Two attributes of one category filter one attribute field.
 */
export function predicateFieldKey(predicate: UserPredicate): string {
  return predicate.field === 'attribute'
    ? `attr:${predicate.schemaName}.${predicate.fieldName}`
    : predicate.field;
}

/**
 * Whether a grid column filter represents this predicate. An alias has no column,
 * and an attribute with any value has no column filter. The store keeps those
 * predicates itself, because the grid only reports the filters of its columns.
 */
export function gridExpresses(predicate: UserPredicate): boolean {
  return (
    predicate.field !== 'aliases' &&
    !(predicate.field === 'attribute' && predicate.operator === 'hasValue')
  );
}

/**
 * The predicates of a query: the grid model in column order, then the predicates
 * that the grid cannot show (R4). A grid filter for one field replaces a kept
 * predicate of that field, so one field never carries two predicates.
 */
export function mergeGridPredicates(
  modeled: readonly UserPredicate[],
  kept: readonly UserPredicate[],
): UserPredicate[] {
  const fields = new Set(modeled.map(predicateFieldKey));
  return [
    ...modeled,
    ...kept.filter(
      (predicate) =>
        gridExpresses(predicate) === false &&
        !fields.has(predicateFieldKey(predicate)),
    ),
  ];
}

/** The form that the grid and the chips agree on: column order, one filter per field. */
export function canonicalPredicates(
  predicates: readonly UserPredicate[],
  attributes: readonly UserAttributeColumn[] = [],
): UserPredicate[] {
  return mergeGridPredicates(
    predicatesFromFilterModel(
      filterModelFromPredicates(predicates, attributes),
      attributes,
    ),
    predicates,
  );
}

export function samePredicates(
  a: readonly UserPredicate[],
  b: readonly UserPredicate[],
  attributes: readonly UserAttributeColumn[] = [],
): boolean {
  return (
    JSON.stringify(canonicalPredicates(a, attributes)) ===
    JSON.stringify(canonicalPredicates(b, attributes))
  );
}

/**
 * The model to give the grid for these predicates, or null when the grid already
 * shows them. Only the predicates that a column filter can show take part, because a
 * filter-only chip changes the query without changing the model (R4).
 */
export function filterModelUpdate(
  current: FilterModel | null,
  predicates: readonly UserPredicate[],
  attributes: readonly UserAttributeColumn[] = [],
): FilterModel | null {
  const next = filterModelFromPredicates(predicates, attributes);
  let shown: UserPredicate[] | null;
  try {
    shown = predicatesFromFilterModel(current, attributes);
  } catch {
    // The current model holds a filter that no query can express. Replace it.
    shown = null;
  }
  if (!shown) return next;
  let wanted: UserPredicate[] | null;
  try {
    wanted = predicatesFromFilterModel(next, attributes);
  } catch {
    // The next model holds such a filter too, so the grid must take it.
    wanted = null;
  }
  if (!wanted) return next;
  return samePredicates(shown, wanted, attributes) ? null : next;
}

/** The OrgUnit set filter shows each path under the root of a tree. */
export function orgUnitTreePath(path: string): string[] {
  return ['/', ...path.split('/').filter(Boolean)];
}
