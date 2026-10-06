import { TestBed } from '@angular/core/testing';
import type {
  DeviceOrgUnit,
  DevicePredicate,
} from '@campus/application-contracts';
import { DeviceFilter } from './device-filter';

function setup(orgUnits: DeviceOrgUnit[] = []) {
  const fixture = TestBed.createComponent(DeviceFilter);
  fixture.componentRef.setInput('orgUnits', orgUnits);
  const applied: DevicePredicate[] = [];
  let closed = 0;
  fixture.componentInstance.applied.subscribe((predicate) =>
    applied.push(predicate),
  );
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
  const start = (text: string) => {
    click(element.querySelector('.add-filter'));
    type('[role="combobox"]', text);
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
    render,
  };
}

it('lists matched fields before shortcut matches', () => {
  const { element, options, start } = setup();
  start('asset');
  expect(
    [...element.querySelectorAll('.group-label')].map((label) =>
      label.textContent?.trim(),
    ),
  ).toEqual(['Matched fields', 'Shortcut matches']);
  expect(options()).toEqual([
    'Asset tag',
    'Asset tag contains "asset"',
    'Serial contains "asset"',
  ]);
});

it('opens a prefilled editor for a shortcut and applies only on Apply', () => {
  const { element, applied, click, button, start } = setup();
  start('HS-04');
  click(element.querySelectorAll('[role="option"]')[0]);
  expect(applied).toEqual([]);
  expect(element.querySelector('h2')?.textContent?.trim()).toBe('Asset tag');
  expect(
    element.querySelector<HTMLInputElement>('input[type="text"]')?.value,
  ).toBe('HS-04');
  click(button('Apply'));
  expect(applied).toEqual([
    { field: 'assetTag', operator: 'contains', value: 'HS-04' },
  ]);
  expect(element.querySelector('.add-filter')).not.toBeNull();
});

it('keeps Apply disabled for blank text', () => {
  const { element, type, click, button, start } = setup();
  start('serial');
  click(element.querySelectorAll('[role="option"]')[0]);
  type('input[type="text"]', '   ');
  expect(button('Apply').disabled).toBe(true);
});

it('selects suggestions with the keyboard', () => {
  const { element, applied, click, button, start, render } = setup();
  start('asset');
  const combobox =
    element.querySelector<HTMLInputElement>('[role="combobox"]')!;
  combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
  render();
  expect(combobox.getAttribute('aria-activedescendant')).toBe(
    element.querySelectorAll('[role="option"]')[1].id,
  );
  combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  render();
  click(button('Apply'));
  expect(applied).toEqual([
    { field: 'assetTag', operator: 'contains', value: 'asset' },
  ]);
});

it('applies the chosen battery classes', () => {
  const { element, applied, click, button, start } = setup();
  start('batt');
  click(element.querySelectorAll('[role="option"]')[0]);
  const box = (label: string) =>
    [...element.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.trim() === label)!
      .querySelector('input');
  click(box('Replace soon'));
  click(box('No battery report'));
  click(button('Apply'));
  expect(applied).toEqual([
    { field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] },
  ]);
});

it('applies an organization unit with the units inside it', () => {
  const { element, applied, click, button, start } = setup([
    { path: '/School A', devices: 5 },
    { path: '/School A/Library', devices: 3 },
    { path: '/School B', devices: 4 },
  ]);
  start('organ');
  click(element.querySelectorAll('[role="option"]')[0]);
  const labels = [...element.querySelectorAll('.unit')].map((unit) =>
    unit.textContent?.trim(),
  );
  expect(labels).toEqual([
    'All organization units',
    'School A',
    'Library',
    'School B',
  ]);
  const boxes = () => [
    ...element.querySelectorAll<HTMLInputElement>('.unit input'),
  ];
  expect(button('Apply').disabled).toBe(true);
  click(boxes()[1]);
  expect(boxes().map((box) => box.checked)).toEqual([false, true, true, false]);
  expect(boxes()[0].indeterminate).toBe(true);
  click(button('Apply'));
  expect(applied).toEqual([
    {
      field: 'orgUnitPath',
      operator: 'in',
      values: ['/School A', '/School A/Library'],
    },
  ]);
});

it('closes on Escape without applying', () => {
  const { element, applied, closed, start, render } = setup();
  start('model');
  element
    .querySelector('[role="combobox"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  render();
  expect(applied).toEqual([]);
  expect(closed()).toBe(1);
  expect(element.querySelector('[role="combobox"]')).toBeNull();
  expect(element.querySelector('.add-filter')).not.toBeNull();
});

it('moves focus into the editor after choosing a field', async () => {
  const { element, click, start, fixture } = setup();
  start('model');
  click(element.querySelectorAll('[role="option"]')[0]);
  await fixture.whenStable();
  expect(document.activeElement).toBe(element.querySelector('.editor select'));
});
