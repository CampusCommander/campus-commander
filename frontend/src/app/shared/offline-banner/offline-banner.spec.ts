import { TestBed } from '@angular/core/testing';
import { OfflineBanner } from './offline-banner';

describe('OfflineBanner', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OfflineBanner],
    }).compileComponents();
  });

  it('announces the offline state through a status live region', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.detectChanges();
    const region = fixture.nativeElement.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(fixture.nativeElement.textContent).toContain('You are offline.');
  });

  it('renders the cached-data timestamp when provided', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    const cachedAt = '2026-09-14T09:30:00.000Z';
    fixture.componentRef.setInput('cachedAt', cachedAt);
    fixture.detectChanges();
    const time = fixture.nativeElement.querySelector('time');
    expect(fixture.nativeElement.textContent).toContain('Showing data cached');
    expect(time.getAttribute('datetime')).toBe(cachedAt);
  });

  it('omits the cached-data note when no cache time exists', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Showing data cached',
    );
  });

  it('renders the writes-disabled note by default', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'Writes are disabled until the server confirms access.',
    );
  });

  it('hides the writes-disabled note when writes remain available', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.componentRef.setInput('writesDisabled', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain(
      'Writes are disabled',
    );
  });

  it('emits reconnect when the operator selects Retry connection', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.reconnect.subscribe(() => emitted++);
    fixture.nativeElement.querySelector('button').click();
    expect(emitted).toBe(1);
  });

  it('disables Retry connection while a reconnect is in progress', () => {
    const fixture = TestBed.createComponent(OfflineBanner);
    fixture.componentRef.setInput('reconnecting', true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
