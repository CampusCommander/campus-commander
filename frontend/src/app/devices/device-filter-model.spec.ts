import type { DevicePredicate } from '@campus/application-contracts';
import {
  canonicalPredicates,
  filterModelFromPredicates,
  filterModelUpdate,
  orgUnitTreePath,
  predicatesFromFilterModel,
} from './device-filter-model';

const day = new Date(2026, 9, 1).toISOString();
const predicates: DevicePredicate[] = [
  { field: 'serialNumber', operator: 'equals', value: 'C0A1-0001' },
  { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  { field: 'orgUnitPath', operator: 'in', values: ['/School A'] },
  { field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] },
  { field: 'lastContact', operator: 'after', value: day },
  { field: 'notes', operator: 'isEmpty' },
];

it('round-trips every filter type through the grid filter model', () => {
  const model = filterModelFromPredicates(predicates);
  expect(model['assetTag']).toEqual({
    filterType: 'text',
    type: 'startsWith',
    filter: 'HS-04',
  });
  expect(model['notes']).toEqual({ filterType: 'text', type: 'blank' });
  expect(model['battery']).toEqual({
    filterType: 'set',
    values: ['replace-soon', 'no-report'],
  });
  expect(model['lastContact']).toEqual({
    filterType: 'date',
    type: 'after',
    dateFrom: '2026-10-01 00:00:00',
    dateTo: null,
  });
  expect(predicatesFromFilterModel(model)).toEqual(predicates);
});

it('orders predicates by column and keeps one filter per field', () => {
  expect(
    canonicalPredicates([
      { field: 'notes', operator: 'isEmpty' },
      { field: 'model', operator: 'contains', value: 'Lenovo' },
      { field: 'model', operator: 'contains', value: 'Dell' },
    ]),
  ).toEqual([
    { field: 'model', operator: 'contains', value: 'Dell' },
    { field: 'notes', operator: 'isEmpty' },
  ]);
});

it('treats an empty model as no filters and an empty set as no matches', () => {
  expect(predicatesFromFilterModel(null)).toEqual([]);
  expect(predicatesFromFilterModel({})).toEqual([]);
  expect(
    predicatesFromFilterModel({ battery: { filterType: 'set', values: [] } }),
  ).toEqual([{ field: 'battery', operator: 'is', values: [] }]);
});

it('refuses filters the device query cannot express', () => {
  const text = (type: string, filter: string) => ({
    model: { filterType: 'text', type, filter },
  });
  expect(() =>
    predicatesFromFilterModel({
      details: { filterType: 'text', type: 'contains', filter: 'x' },
    }),
  ).toThrow();
  expect(() => predicatesFromFilterModel(text('notContains', 'x'))).toThrow();
  expect(() =>
    predicatesFromFilterModel(text('contains', 'x'.repeat(257))),
  ).toThrow();
});

it('updates the grid only when the chips differ from its filters', () => {
  const chips: DevicePredicate[] = [{ field: 'notes', operator: 'isEmpty' }];
  const model = filterModelFromPredicates(chips);
  expect(filterModelUpdate(model, chips)).toBeNull();
  expect(filterModelUpdate({}, chips)).toEqual(model);
  expect(filterModelUpdate(model, [])).toEqual({});
});

it('places organization units under the root of the filter tree', () => {
  expect(orgUnitTreePath('/')).toEqual(['/']);
  expect(orgUnitTreePath('/School A/Library')).toEqual([
    '/',
    'School A',
    'Library',
  ]);
});
