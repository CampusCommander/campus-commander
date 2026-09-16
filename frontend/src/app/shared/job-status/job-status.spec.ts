import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatProgressBar } from '@angular/material/progress-bar';
import { JobStatus, JobStatusValue } from './job-status';

describe('JobStatus', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [JobStatus],
    }).compileComponents();
  });

  function create(status: JobStatusValue) {
    const fixture = TestBed.createComponent(JobStatus);
    fixture.componentRef.setInput('status', status);
    return fixture;
  }

  it('announces the status through a polite live region', () => {
    const fixture = create('running');
    fixture.detectChanges();
    const region = fixture.nativeElement.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it.each([
    ['accepted', 'Accepted'],
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['completed-with-errors', 'Completed with errors'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as [JobStatusValue, string][])(
    'renders the %s label truthfully',
    (status, label) => {
      const fixture = create(status);
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(label);
    },
  );

  it('shows indeterminate progress while queued', () => {
    const fixture = create('queued');
    fixture.detectChanges();
    const bar = fixture.debugElement.query(By.directive(MatProgressBar));
    expect(bar.componentInstance.mode).toBe('indeterminate');
  });

  it('shows determinate progress from outcome counts while running', () => {
    const fixture = create('running');
    fixture.componentRef.setInput('succeeded', 20);
    fixture.componentRef.setInput('failed', 5);
    fixture.componentRef.setInput('pending', 25);
    fixture.componentRef.setInput('total', 50);
    fixture.detectChanges();
    const bar = fixture.debugElement.query(By.directive(MatProgressBar));
    expect(bar.componentInstance.mode).toBe('determinate');
    expect(bar.componentInstance.value).toBe(50);
  });

  it('preserves every outcome for a job completed with errors', () => {
    const fixture = create('completed-with-errors');
    fixture.componentRef.setInput('succeeded', 21);
    fixture.componentRef.setInput('failed', 3);
    fixture.componentRef.setInput('skipped', 1);
    fixture.componentRef.setInput('unknown', 2);
    fixture.componentRef.setInput('cancelled', 1);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Completed with errors');
    expect(text).toContain('21 succeeded');
    expect(text).toContain('3 failed');
    expect(text).toContain('1 skipped');
    expect(text).toContain('2 unknown');
    expect(text).toContain('1 cancelled');
  });

  it('omits counts that were not reported', () => {
    const fixture = create('completed');
    fixture.componentRef.setInput('succeeded', 24);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('24 succeeded');
    expect(text).not.toContain('failed');
  });
});
