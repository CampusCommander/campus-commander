import type { FilterModel } from 'ag-grid-community';
import { z } from 'zod';
import {
  devicePredicateSchema,
  type DevicePredicate,
} from '@campus/application-contracts';
import {
  DEVICE_FIELDS,
  dateInputToIso,
  dateInputValue,
  type DeviceField,
} from './device-fields';

const textModel = z.object({
  filterType: z.literal('text'),
  type: z.enum(['contains', 'startsWith', 'equals', 'blank']),
  filter: z.string().nullish(),
});
const dateModel = z.object({
  filterType: z.literal('date'),
  type: z.enum(['before', 'after']),
  dateFrom: z.string(),
});
const setModel = z.object({
  filterType: z.literal('set'),
  values: z.array(z.string()),
});

function predicateFor(field: DeviceField, model: unknown): unknown {
  if (field.kind === 'text') {
    const text = textModel.parse(model);
    return text.type === 'blank'
      ? { field: field.id, operator: 'isEmpty' }
      : { field: field.id, operator: text.type, value: text.filter ?? '' };
  }
  if (field.kind === 'date') {
    const date = dateModel.parse(model);
    return {
      field: field.id,
      operator: date.type,
      value: dateInputToIso(date.dateFrom.slice(0, 10)),
    };
  }
  const set = setModel.parse(model);
  return {
    field: field.id,
    operator: field.kind === 'battery' ? 'is' : 'in',
    values: set.values,
  };
}

/**
 * Translate the grid's column filters to device predicates in column order.
 * A model that the device query cannot express throws. The grid then shows a failed load instead of unfiltered rows.
 */
export function predicatesFromFilterModel(
  model: FilterModel | null | undefined,
): DevicePredicate[] {
  const entries: FilterModel = model ?? {};
  for (const key of Object.keys(entries))
    if (!DEVICE_FIELDS.some((field) => field.id === key))
      throw new Error(`The device query has no filter for ${key}.`);
  return DEVICE_FIELDS.flatMap((field) =>
    entries[field.id]
      ? [devicePredicateSchema.parse(predicateFor(field, entries[field.id]))]
      : [],
  );
}

export function filterModelFromPredicates(
  predicates: readonly DevicePredicate[],
): FilterModel {
  const model: FilterModel = {};
  for (const predicate of predicates) {
    if (predicate.field === 'battery' || predicate.field === 'orgUnitPath')
      model[predicate.field] = {
        filterType: 'set',
        values: [...predicate.values],
      };
    else if (predicate.field === 'lastContact')
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
  return model;
}

/** The form that the grid and the chips agree on: column order, one filter per field. */
export function canonicalPredicates(
  predicates: readonly DevicePredicate[],
): DevicePredicate[] {
  return predicatesFromFilterModel(filterModelFromPredicates(predicates));
}

export function samePredicates(
  a: readonly DevicePredicate[],
  b: readonly DevicePredicate[],
): boolean {
  return (
    JSON.stringify(canonicalPredicates(a)) ===
    JSON.stringify(canonicalPredicates(b))
  );
}

/** The model to give the grid for these predicates, or null when the grid already shows them. */
export function filterModelUpdate(
  current: FilterModel | null,
  predicates: readonly DevicePredicate[],
): FilterModel | null {
  let shown: DevicePredicate[] | null;
  try {
    shown = predicatesFromFilterModel(current);
  } catch {
    shown = null;
  }
  return shown && samePredicates(shown, predicates)
    ? null
    : filterModelFromPredicates(predicates);
}

/** The OrgUnit set filter shows each path under the root of a tree. */
export function orgUnitTreePath(path: string): string[] {
  return ['/', ...path.split('/').filter(Boolean)];
}
