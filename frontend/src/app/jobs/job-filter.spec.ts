import { TestBed } from '@angular/core/testing';
import type { JobPerson } from '@campus/application-contracts';
import { JobFilterEditor, type RequesterLoader } from './job-filter';
import type { JobFilter } from './job-fields';

const people: JobPerson[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Maya Chen',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    displayName: 'Alex Rivera',
  },
];

function setup(requesters: RequesterLoader = async () => people) {
  const fixture = TestBed.createComponent(JobFilterEditor);
  fixture.componentRef.setInput('requesters', requesters);
  const applied: JobFilter[] = [];
  let closed = 0;
  fixture.componentInstance.applied.subscribe((filter) => applied.push(filter));
  fixture.componentInstance.closed.subscribe(() => closed++);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const render = () => fixture.detectChanges();
  const type = (selector: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    render();
  };
  const click = (target: Element | null) => {
    (target as HTMLElement).click();
    render();
  };
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    )!;
  const options = () =>
    [...element.querySelectorAll('[role="option"]')].map((option) =>
      option.textContent?.trim(),
    );
  const start = (text = '') => {
    click(element.querySelector('.add-filter'));
    if (text) type('[role="combobox"]', text);
  };
  const chooseField = (label: string) =>
    click(
      [...element.querySelectorAll('[role="option"]')].find(
        (option) => option.textContent?.trim() === label,
      ) ?? null,
    );
  const check = (label: string) =>
    click(
      [...element.querySelectorAll('label')]
        .find((candidate) => candidate.textContent?.trim() === label)!
        .querySelector('input'),
    );
  const settle = async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
    render();
  };
  return {
    fixture,
    element,
    applied,
    closed: () => closed,
    type,
    click,
    button,
    options,
    start,
    chooseField,
    check,
    settle,
    render,
  };
}

it('matches the typed field label', () => {
  const { options, start } = setup();
  start('status');
  expect(options()).toEqual(['Status']);
});

it('offers the seven server filters', () => {
  const { options, start } = setup();
  start();
  expect(options()).toEqual([
    'Job ID',
    'Status',
    'Action',
    'Entity type',
    'Requested by',
    'Created',
    'Finished',
  ]);
});

it('applies a status multi-select from the filtered frame', () => {
  const { applied, button, check, chooseField, start } = setup();
  start();
  chooseField('Status');
  expect(button('Apply').disabled).toBe(true);
  check('Needs review');
  check('Completed with errors');
  expect(button('Apply').disabled).toBe(false);
  button('Apply').click();
  expect(applied).toEqual([
    { field: 'status', values: ['needs-review', 'completed-with-errors'] },
  ]);
});

it('applies an action filter', () => {
  const { applied, button, check, chooseField, start } = setup();
  start();
  chooseField('Action');
  check('Refresh inventory');
  button('Apply').click();
  expect(applied).toEqual([{ field: 'action', values: ['refresh-inventory'] }]);
});

it('applies the entity type of this slice', () => {
  const { applied, button, check, chooseField, start } = setup();
  start();
  chooseField('Entity type');
  check('Device');
  button('Apply').click();
  expect(applied).toEqual([{ field: 'entityType', values: ['device'] }]);
});

it('applies a job ID and rejects another display ID shape', () => {
  const { applied, button, chooseField, element, start, type } = setup();
  start();
  chooseField('Job ID');
  type('input[type="text"]', 'JOB-999');
  expect(button('Apply').disabled).toBe(true);
  expect(element.textContent).toContain('Use a job ID such as UPD-014');
  type('input[type="text"]', 'UPD-006');
  button('Apply').click();
  expect(applied).toEqual([{ field: 'jobId', value: 'UPD-006' }]);
});

it('reads requesters for the actor autocomplete', async () => {
  let query = '';
  const requesters = async (value: string) => {
    query = value;
    return people;
  };
  const { applied, button, chooseField, element, render, settle, start, type } =
    setup(requesters);
  start();
  chooseField('Requested by');
  await settle();
  expect(query).toBe('');
  expect(
    [...element.querySelectorAll('.people button')].map((candidate) =>
      candidate.textContent?.trim(),
    ),
  ).toEqual(['Maya Chen', 'Alex Rivera']);
  type('input[type="search"]', 'May');
  await settle();
  expect(query).toBe('May');
  const maya = [...element.querySelectorAll('.people button')].find(
    (candidate) => candidate.textContent?.trim() === 'Maya Chen',
  ) as HTMLButtonElement;
  maya.click();
  render();
  expect(button('Apply').disabled).toBe(false);
  button('Apply').click();
  expect(applied).toEqual([
    {
      field: 'requestedBy',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Maya Chen',
    },
  ]);
});

it('reports unavailable requesters without closing the editor', async () => {
  const { chooseField, element, settle, start } = setup(async () => null);
  start();
  chooseField('Requested by');
  await settle();
  expect(element.textContent).toContain('Requesters are unavailable.');
  expect(element.querySelector('[role="dialog"]')).not.toBeNull();
});

it('applies a date-time range and rejects a reversed range', () => {
  const { applied, button, chooseField, element, render, start } = setup();
  start();
  chooseField('Created');
  const [from, to] = element.querySelectorAll<HTMLInputElement>(
    'input[type="datetime-local"]',
  );
  from.value = '2026-09-06T10:00';
  from.dispatchEvent(new Event('input'));
  render();
  to.value = '2026-09-05T10:00';
  to.dispatchEvent(new Event('input'));
  render();
  expect(button('Apply').disabled).toBe(true);
  expect(element.textContent).toContain('The start must be before the end.');
  to.value = '2026-09-07T10:00';
  to.dispatchEvent(new Event('input'));
  render();
  button('Apply').click();
  const filter = applied[0];
  expect(filter.field).toBe('createdAt');
  if (filter.field !== 'createdAt') return;
  expect(new Date(filter.from!).getTime()).toBe(
    new Date('2026-09-06T10:00').getTime(),
  );
  expect(new Date(filter.to!).getTime()).toBe(
    new Date('2026-09-07T10:00').getTime(),
  );
  expect(filter.preset).toBeUndefined();
});

it('opens the Last 7 days shortcut prefilled from the frame', () => {
  const { applied, button, click, element, options, render } = setup();
  click(element.querySelector('.add-filter'));
  const combobox =
    element.querySelector<HTMLInputElement>('[role="combobox"]')!;
  combobox.value = 'last';
  combobox.dispatchEvent(new Event('input'));
  render();
  expect(options()).toEqual(['Created: Last 7 days']);
  click(element.querySelectorAll('[role="option"]')[0]);
  button('Apply').click();
  const filter = applied[0];
  expect(filter.field).toBe('createdAt');
  if (filter.field !== 'createdAt') return;
  expect(filter.preset).toBe('last-7-days');
  expect(
    new Date(filter.to!).getTime() - new Date(filter.from!).getTime(),
  ).toBe(7 * 86_400_000);
});

it('prefills the editor of an existing chip', () => {
  const { applied, button, fixture, render } = setup();
  fixture.componentRef.setInput('editing', {
    field: 'status',
    values: ['held'],
  });
  render();
  expect(
    fixture.nativeElement
      .querySelector('[role="dialog"] h2')
      ?.textContent?.trim(),
  ).toBe('Status');
  button('Apply').click();
  expect(applied).toEqual([{ field: 'status', values: ['held'] }]);
});

it('closes on Escape without applying and returns focus to the trigger', async () => {
  const { applied, closed, element, fixture, render, start } = setup();
  start();
  element
    .querySelector('[role="combobox"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  render();
  await fixture.whenStable();
  expect(applied).toEqual([]);
  expect(closed()).toBe(1);
  expect(element.querySelector('.add-filter')).not.toBeNull();
  expect(document.activeElement?.textContent?.trim()).toContain('Add a filter');
});
