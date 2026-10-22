import { TestBed } from '@angular/core/testing';
import { OuReferencePicker } from './ou-reference-picker';

const units = [
  { id: 'root', parentId: null, name: 'Customer', path: '/' },
  { id: 'a', parentId: 'root', name: 'School A', path: '/School A' },
  { id: 'child', parentId: 'a', name: 'Students', path: '/School A/Students' },
  { id: 'b', parentId: 'root', name: 'School B', path: '/School B' },
];

async function setup() {
  await TestBed.configureTestingModule({
    imports: [OuReferencePicker],
  }).compileComponents();
  const fixture = TestBed.createComponent(OuReferencePicker);
  fixture.componentRef.setInput('units', units);
  fixture.componentRef.setInput('selectedId', 'b');
  fixture.detectChanges();
  const host: HTMLElement = fixture.nativeElement;
  const item = (id: string) => {
    const found = host.querySelector<HTMLElement>(`[data-ou-id="${id}"]`);
    if (!found) throw new Error(`Missing tree item ${id}.`);
    return found;
  };
  const key = async (id: string, value: string) => {
    item(id).dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, host, item, key };
}

it('navigates and expands the hierarchy without changing selection', async () => {
  const { fixture, host, item, key } = await setup();
  const selected: string[] = [];
  fixture.componentInstance.selected.subscribe((id) => selected.push(id));
  item('root').focus();
  expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(host.querySelector('[data-ou-id="child"]')).toBeNull();
  await key('root', 'ArrowDown');
  expect(document.activeElement).toBe(item('a'));
  await key('a', 'ArrowRight');
  expect(item('a').getAttribute('aria-expanded')).toBe('true');
  expect(item('child').getAttribute('aria-level')).toBe('3');
  await key('a', 'ArrowRight');
  expect(document.activeElement).toBe(item('child'));
  await key('child', 'ArrowLeft');
  expect(document.activeElement).toBe(item('a'));
  await key('a', 'ArrowLeft');
  expect(host.querySelector('[data-ou-id="child"]')).toBeNull();
  await key('a', 'End');
  expect(document.activeElement).toBe(item('b'));
  await key('b', 'Home');
  expect(document.activeElement).toBe(item('root'));
  expect(item('b').getAttribute('aria-selected')).toBe('true');
  expect(selected).toEqual([]);
  await key('root', 'Enter');
  await key('root', ' ');
  expect(selected).toEqual(['root', 'root']);
});

it('retains focus and selection by stable identity after a rename', async () => {
  const { fixture, item } = await setup();
  item('b').focus();
  fixture.componentRef.setInput(
    'units',
    units.map((unit) =>
      unit.id === 'b'
        ? { ...unit, name: 'Renamed school', path: '/Renamed school' }
        : unit,
    ),
  );
  fixture.detectChanges();
  await fixture.whenStable();
  expect(document.activeElement).toBe(item('b'));
  expect(item('b').textContent).toContain('Renamed school');
  expect(item('b').getAttribute('aria-selected')).toBe('true');
  expect(item('b').getAttribute('aria-posinset')).toBe('1');
});

it('permits reference inspection but prevents selection when disabled', async () => {
  const { fixture, item, key } = await setup();
  const selected: string[] = [];
  fixture.componentInstance.selected.subscribe((id) => selected.push(id));
  fixture.componentRef.setInput('disabled', true);
  fixture.detectChanges();
  await key('a', 'ArrowRight');
  expect(item('child')).toBeTruthy();
  await key('a', 'Enter');
  item('b').click();
  expect(selected).toEqual([]);
});

it('shows a search match with its ancestors and no expansion control', async () => {
  const { fixture, host, item } = await setup();
  // The query is a path fragment; the match and its ancestors show, fully expanded.
  fixture.componentRef.setInput('query', '/school a/students');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(item('child')).toBeTruthy();
  expect(item('a')).toBeTruthy();
  expect(host.querySelector('[data-ou-id="b"]')).toBeNull();
  expect(host.querySelector('[aria-label="Expand School A"]')).toBeNull();
  expect(item('a').getAttribute('aria-expanded')).toBe('true');
});

it('shows no row when the search matches no unit', async () => {
  const { fixture, host } = await setup();
  fixture.componentRef.setInput('query', 'no such unit');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
  expect(host.textContent).toContain('No organization units match.');
});

it('reveals the selected unit inside a collapsed branch', async () => {
  const { fixture, item } = await setup();
  fixture.componentRef.setInput('selectedId', 'child');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(item('child').getAttribute('aria-selected')).toBe('true');
  expect(item('a').getAttribute('aria-expanded')).toBe('true');
});

it('reveals the focused identity after reparenting beneath a collapsed ancestor', async () => {
  const { fixture, host, item } = await setup();
  const selected: string[] = [];
  fixture.componentInstance.selected.subscribe((id) => selected.push(id));
  expect(item('a').getAttribute('aria-expanded')).toBe('false');
  item('b').focus();
  fixture.componentRef.setInput(
    'units',
    units.map((unit) =>
      unit.id === 'b'
        ? { ...unit, parentId: 'a', path: '/School A/School B' }
        : unit,
    ),
  );
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(item('a').getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(item('b'));
  expect(item('b').getAttribute('aria-selected')).toBe('true');
  expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(selected).toEqual([]);
});
