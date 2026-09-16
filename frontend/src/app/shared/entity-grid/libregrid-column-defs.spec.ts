import { TestBed } from '@angular/core/testing';
import { EntityGridDetailsCell, type DetailsCellParams } from './details-cell';
import {
  DETAILS_COLUMN_ID,
  editorMetadata,
  toColumnDefs,
} from './libregrid-column-defs';
import type { EntityGridConfig } from './entity-grid-config';

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
        fieldId: 'serial',
        label: 'Serial',
        dataType: 'text',
        inGridEditor: null,
        filterable: true,
        code: true,
        value: (row) => row.id,
      },
      {
        fieldId: 'notes',
        label: 'Notes',
        dataType: 'text',
        inGridEditor: 'multilineText',
        filterable: true,
        defaultVisible: false,
        value: () => null,
      },
    ],
    getRowId: (row) => row.id,
    entityLabel: (row) => row.name,
    bulkActions: [],
  };
}

describe('toColumnDefs', () => {
  it('places the details column before data columns in config order', () => {
    const defs = toColumnDefs(testConfig(), () => undefined);
    expect(defs.map((def) => def.colId)).toEqual([
      DETAILS_COLUMN_ID,
      'name',
      'serial',
      'notes',
    ]);
  });

  it('renders details through the eye-icon cell renderer', () => {
    const defs = toColumnDefs(testConfig(), () => undefined);
    expect(defs[0].cellRenderer).toBe(EntityGridDetailsCell);
  });

  it('keeps every data column read-only pending GRID-05 qualification', () => {
    const defs = toColumnDefs(testConfig(), () => undefined);
    for (const def of defs.slice(1)) {
      expect(def.editable).toBe(false);
    }
  });

  it('hides columns the contract marks as not default visible', () => {
    const defs = toColumnDefs(testConfig(), () => undefined);
    expect(defs[3].hide).toBe(true);
    expect(defs[1].hide).toBe(false);
  });

  it('preserves inGridEditor metadata beside the grid, not inside options', () => {
    expect(editorMetadata(testConfig())).toEqual({
      name: 'text',
      serial: null,
      notes: 'multilineText',
    });
  });
});

describe('EntityGridDetailsCell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EntityGridDetailsCell],
    }).compileComponents();
  });

  function create(onDetails: (stableId: string) => void) {
    const fixture = TestBed.createComponent(EntityGridDetailsCell);
    fixture.componentInstance.agInit({
      data: { id: 'row-1', name: 'Alpha' },
      getRowId: (row) => (row as TestRow).id,
      entityLabel: (row) => (row as TestRow).name,
      onDetails,
    } as DetailsCellParams);
    fixture.detectChanges();
    return fixture;
  }

  it('emits the stable entity id when activated', () => {
    const emitted: string[] = [];
    const fixture = create((stableId) => emitted.push(stableId));
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    button.click();
    expect(emitted).toEqual(['row-1']);
  });

  it('uses the entity label in its accessible name', () => {
    const fixture = create(() => undefined);
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    expect(button.getAttribute('aria-label')).toBe('Open details for Alpha');
    expect(button.getAttribute('title')).toBe('Open details for Alpha');
  });
});
