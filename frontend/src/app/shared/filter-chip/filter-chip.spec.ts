import { TestBed } from '@angular/core/testing';
import { FilterChip } from './filter-chip';

describe('FilterChip', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FilterChip],
    }).compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(FilterChip);
    fixture.componentRef.setInput('field', 'Status');
    fixture.componentRef.setInput('operator', 'is');
    fixture.componentRef.setInput('value', 'Disabled');
    fixture.detectChanges();
    return fixture;
  }

  it('renders field, operator, and value', () => {
    const fixture = create();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Status');
    expect(text).toContain('is');
    expect(text).toContain('Disabled');
  });

  it('emits edit when the operator selects the chip body', () => {
    const fixture = create();
    let emitted = 0;
    fixture.componentInstance.edit.subscribe(() => emitted++);
    fixture.nativeElement.querySelector('.filter-chip-body').click();
    expect(emitted).toBe(1);
  });

  it('emits remove when the operator selects the remove button', () => {
    const fixture = create();
    let emitted = 0;
    fixture.componentInstance.remove.subscribe(() => emitted++);
    fixture.nativeElement.querySelector('.filter-chip-remove').click();
    expect(emitted).toBe(1);
  });

  it('gives both actions accessible names', () => {
    const fixture = create();
    const body = fixture.nativeElement.querySelector('.filter-chip-body');
    const remove = fixture.nativeElement.querySelector('.filter-chip-remove');
    expect(body.getAttribute('aria-label')).toBe(
      'Edit filter: Status is Disabled',
    );
    expect(remove.getAttribute('aria-label')).toBe('Remove filter: Status');
  });
});
