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
