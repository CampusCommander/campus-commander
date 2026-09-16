import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import { StaleBadge } from './stale-badge';

describe('StaleBadge', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StaleBadge],
    }).compileComponents();
  });

  function create(observedAt: string) {
    const fixture = TestBed.createComponent(StaleBadge);
    fixture.componentRef.setInput('observedAt', observedAt);
    return fixture;
  }

  it('renders relative observation time without a stale label when fresh', () => {
    const fixture = create(new Date(Date.now() - 30_000).toISOString());
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Observed');
    expect(text).toContain('seconds ago');
    expect(text).not.toContain('Stale observation');
  });

  it('renders the stale label when the observation exceeds the threshold', () => {
    const fixture = create(new Date(Date.now() - 600_000).toISOString());
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Stale observation');
    expect(text).toContain('minutes ago');
  });

  it('honors a custom staleness threshold', () => {
    const fixture = create(new Date(Date.now() - 120_000).toISOString());
    fixture.componentRef.setInput('staleAfterSeconds', 60);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Stale observation');
  });

  it('exposes the exact timestamp on demand through a tooltip', () => {
    const observedAt = new Date(Date.now() - 30_000).toISOString();
    const fixture = create(observedAt);
    fixture.detectChanges();
    const time = fixture.nativeElement.querySelector('time');
    expect(time.getAttribute('datetime')).toBe(observedAt);
    const tooltip = fixture.debugElement.query(By.directive(MatTooltip));
    expect(tooltip).toBeTruthy();
    expect(tooltip.injector.get(MatTooltip).message).toContain('2026');
  });

  it('emits refresh when the operator selects Refresh', () => {
    const fixture = create(new Date().toISOString());
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.refresh.subscribe(() => emitted++);
    fixture.nativeElement.querySelector('button').click();
    expect(emitted).toBe(1);
  });

  it('disables Refresh while a refresh is in progress', () => {
    const fixture = create(new Date().toISOString());
    fixture.componentRef.setInput('refreshing', true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('announces freshness changes through a polite live region', () => {
    const fixture = create(new Date().toISOString());
    fixture.detectChanges();
    const region = fixture.nativeElement.querySelector('.stale-badge');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });
});
