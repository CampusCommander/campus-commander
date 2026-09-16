import { TestBed } from '@angular/core/testing';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EmptyState],
    }).compileComponents();
  });

  it('renders the title and the no-data message by default', () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('title', 'No devices');
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h2')?.textContent).toContain('No devices');
    expect(element.textContent).toContain('There are no records to show yet.');
  });

  it('renders the no-matches message when filters exclude every record', () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('title', 'No devices');
    fixture.componentRef.setInput('reason', 'no-matches');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'No records match the active filters.',
    );
  });

  it('renders a custom message when provided', () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('title', 'No jobs');
    fixture.componentRef.setInput('message', 'No jobs ran in the selected period.');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'No jobs ran in the selected period.',
    );
  });

  it('labels the region with the title for assistive technology', () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('title', 'No devices');
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const section = element.querySelector('section');
    const heading = element.querySelector('h2');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
  });
});
