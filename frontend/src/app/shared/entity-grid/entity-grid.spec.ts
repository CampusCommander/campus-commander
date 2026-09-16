import { Component, input, output, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { DataRegion, type DataRegionState } from '../data-region/data-region';
import { FilterChip } from '../filter-chip/filter-chip';
import { Skeleton } from '../skeleton/skeleton';
import { EntityGrid } from './entity-grid';
import {
  createDeviceGridConfig,
  DEVICE_GRID_COLUMNS,
} from './device-grid.config';
import type {
  EntityGridConfig,
  EntityGridFilter,
} from './entity-grid-config';
import { EntityGridViewportLoader } from './entity-grid-viewport-loader';

interface TestRow {
  id: string;
  name: string;
}

function testConfig(): EntityGridConfig<TestRow> {
  return {
    gridId: 'test-grid',
    columns: [
      {
        fieldId: 'name',
        label: 'Name',
        dataType: 'text',
        inGridEditor: 'text',
        filterable: true,
        value: (row) => row.name,
      },
      {
        fieldId: 'code',
        label: 'Code',
        dataType: 'text',
        inGridEditor: null,
        filterable: true,
        value: (row) => row.id,
      },
    ],
    getRowId: (row) => row.id,
    entityLabel: (row) => row.name,
    bulkActions: [{ id: 'export', label: 'Export' }],
  };
}

@Component({
  selector: 'app-stub-viewport',
  template: '<div class="stub-viewport"></div>',
})
class StubViewport {
  readonly config = input.required<EntityGridConfig<TestRow>>();
  readonly rows = input<TestRow[]>([]);
  readonly dataSource = input<unknown | null>(null);
  readonly selectionProvider = input<unknown | null>(null);
  readonly detailsRequested = output<string>();
  readonly rowSelectionChange = output<ReadonlySet<string>>();
}

class StubViewportLoader {
  load(): Promise<Type<unknown>> {
    return Promise.resolve(StubViewport as Type<unknown>);
  }
}

describe('EntityGrid', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EntityGrid],
      providers: [
        { provide: EntityGridViewportLoader, useClass: StubViewportLoader },
      ],
    }).compileComponents();
  });

  function create(
    state: DataRegionState = { status: 'ready' },
  ): ComponentFixture<EntityGrid<TestRow>> {
    const fixture = TestBed.createComponent(
      EntityGrid,
    ) as ComponentFixture<EntityGrid<TestRow>>;
    fixture.componentRef.setInput('config', testConfig());
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('rows', [
      { id: 'row-1', name: 'Alpha' },
    ]);
    fixture.detectChanges();
    return fixture;
  }

  function dataRegion(fixture: ComponentFixture<EntityGrid<TestRow>>) {
    const debugElement = fixture.debugElement.query(By.directive(DataRegion));
    expect(debugElement).not.toBeNull();
    return debugElement.injector.get(DataRegion);
  }

  function filterChips(fixture: ComponentFixture<EntityGrid<TestRow>>) {
    return fixture.debugElement
      .queryAll(By.directive(FilterChip))
      .map((debugElement) => debugElement.injector.get(FilterChip));
  }

  it('orders data columns after the config contract order', () => {
    const fixture = create();
    const columns = fixture.componentInstance.visibleColumns();
    expect(columns.map((column) => column.fieldId)).toEqual(['name', 'code']);
  });

  it('keeps the device columns in the entity-grid-fields.json order', () => {
    expect(DEVICE_GRID_COLUMNS.map((column) => column.fieldId)).toEqual([
      'serial',
      'model',
      'assetTag',
      'school',
      'orgUnit',
      'batteryClassification',
      'deviceContact',
      'annotatedLocation',
      'notes',
    ]);
    const config = createDeviceGridConfig();
    expect(config.columns.every((column) => 'inGridEditor' in column)).toBe(
      true,
    );
  });

  it('mounts the vendor viewport for content states only', async () => {
    const fixture = create({ status: 'loading' });
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelector('.stub-viewport'),
    ).toBeNull();

    fixture.componentRef.setInput('state', { status: 'ready' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.stub-viewport'),
    ).not.toBeNull();
  });

  it('emits detail navigation with the stable entity id', async () => {
    const fixture = create();
    await fixture.whenStable();
    fixture.detectChanges();
    const viewport = fixture.debugElement.query(By.directive(StubViewport));
    expect(viewport).not.toBeNull();
    const emitted: string[] = [];
    fixture.componentInstance.detailNavigation.subscribe((stableId) =>
      emitted.push(stableId),
    );
    viewport.injector.get(StubViewport).detailsRequested.emit('row-1');
    expect(emitted).toEqual(['row-1']);
  });

  it('round-trips filter chip removal through app-filter-chip', () => {
    const fixture = create();
    const filter: EntityGridFilter = {
      fieldId: 'name',
      fieldLabel: 'Name',
      operator: 'contains',
      valueLabel: 'Alpha',
    };
    fixture.componentRef.setInput('filters', [filter]);
    fixture.detectChanges();

    const chips = filterChips(fixture);
    expect(chips).toHaveLength(1);
    expect(chips[0].field()).toBe('Name');
    expect(chips[0].operator()).toBe('contains');
    expect(chips[0].value()).toBe('Alpha');

    const removed: EntityGridFilter[] = [];
    fixture.componentInstance.filterRemoved.subscribe((value) =>
      removed.push(value),
    );
    const removeButton: HTMLElement = fixture.nativeElement.querySelector(
      '.filter-chip-remove',
    );
    removeButton.click();
    fixture.detectChanges();

    expect(removed).toEqual([filter]);
    expect(fixture.componentInstance.filters()).toEqual([]);
    expect(filterChips(fixture)).toHaveLength(0);
  });

  it('adds a filter through the in-row entry and Apply', () => {
    const fixture = create();
    const added: EntityGridFilter[] = [];
    fixture.componentInstance.filterAdded.subscribe((value) =>
      added.push(value),
    );

    const addButton: HTMLElement =
      fixture.nativeElement.querySelector('.add-filter');
    addButton.click();
    fixture.detectChanges();

    const fieldSelect: HTMLSelectElement =
      fixture.nativeElement.querySelector('#filter-field');
    fieldSelect.value = 'name';
    fieldSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const operatorSelect: HTMLSelectElement =
      fixture.nativeElement.querySelector('#filter-operator');
    operatorSelect.value = 'contains';
    operatorSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const applyButton: HTMLButtonElement =
      fixture.nativeElement.querySelector('.filter-entry-apply');
    expect(applyButton.disabled).toBe(true);

    const valueInput: HTMLInputElement =
      fixture.nativeElement.querySelector('#filter-value');
    valueInput.value = 'Alpha';
    valueInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(applyButton.disabled).toBe(false);
    applyButton.click();
    fixture.detectChanges();

    expect(added).toEqual([
      {
        fieldId: 'name',
        fieldLabel: 'Name',
        operator: 'contains',
        valueLabel: 'Alpha',
      },
    ]);
    expect(filterChips(fixture)).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.add-filter')).not.toBeNull();
  });

  it('cancels the filter entry with Escape without adding a chip', () => {
    const fixture = create();
    fixture.nativeElement.querySelector('.add-filter').click();
    fixture.detectChanges();
    const valueInput: HTMLElement =
      fixture.nativeElement.querySelector('#filter-value');
    valueInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.filters()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.add-filter')).not.toBeNull();
  });

  it('renders the persistent selection footer with counts and controls', () => {
    const fixture = create();
    fixture.componentRef.setInput('selectedCount', 3);
    fixture.componentRef.setInput('selectionScope', 'All devices matching 2 filters');
    fixture.detectChanges();

    const footer: HTMLElement =
      fixture.nativeElement.querySelector('.entity-grid-footer');
    expect(footer.textContent).toContain('3 selected');
    expect(footer.textContent).toContain('All devices matching 2 filters');

    const events: string[] = [];
    const instance = fixture.componentInstance;
    instance.selectAll.subscribe(() => events.push('selectAll'));
    instance.deselectAll.subscribe(() => events.push('deselectAll'));
    instance.showAllSelected.subscribe(() => events.push('showAllSelected'));

    const buttons = Array.from(
      footer.querySelectorAll<HTMLButtonElement>('.footer-action'),
    );
    const byText = (text: string) =>
      buttons.find((button) => button.textContent?.trim() === text);
    byText('Select All')?.click();
    byText('Deselect All')?.click();
    byText('Show All Selected')?.click();
    expect(events).toEqual(['selectAll', 'deselectAll', 'showAllSelected']);
  });

  it('disables selection-dependent controls when the selection is empty', () => {
    const fixture = create();
    fixture.detectChanges();
    const footer: HTMLElement =
      fixture.nativeElement.querySelector('.entity-grid-footer');
    expect(footer.textContent).toContain('0 selected');
    const deselect = Array.from(
      footer.querySelectorAll<HTMLButtonElement>('.footer-action'),
    ).find((button) => button.textContent?.trim() === 'Deselect All');
    expect(deselect?.disabled).toBe(true);
  });

  it('shows the selected-view restore control when filtering to selected rows', () => {
    const fixture = create();
    fixture.componentRef.setInput('selectedCount', 2);
    fixture.componentRef.setInput('showSelectedOnly', true);
    fixture.detectChanges();
    const footer: HTMLElement =
      fixture.nativeElement.querySelector('.entity-grid-footer');
    expect(footer.textContent).toContain('Show All Rows');
    expect(footer.textContent).not.toContain('Show All Selected');
  });

  it.each([
    [{ status: 'loading' } as DataRegionState, 'loading'],
    [
      {
        status: 'empty',
        reason: 'no-matches',
        title: 'No matches',
      } as DataRegionState,
      'empty',
    ],
    [
      { status: 'error', title: 'Failed', cause: 'Timeout' } as DataRegionState,
      'error',
    ],
    [
      { status: 'partial', succeeded: 3, failed: 1 } as DataRegionState,
      'partial',
    ],
    [
      { status: 'stale', observedAt: '2026-09-16T10:00:00Z' } as DataRegionState,
      'stale',
    ],
    [
      { status: 'offline', cachedAt: '2026-09-16T10:00:00Z' } as DataRegionState,
      'offline',
    ],
  ])('routes the %s state through app-data-region', (state, expected) => {
    const fixture = create(state);
    expect(dataRegion(fixture).state().status).toBe(expected);
  });

  it('renders the loading skeleton and keeps the footer mounted', () => {
    const fixture = create({ status: 'loading' });
    const skeleton = fixture.debugElement.query(By.directive(Skeleton));
    expect(skeleton).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('.entity-grid-footer'),
    ).not.toBeNull();
  });
});
