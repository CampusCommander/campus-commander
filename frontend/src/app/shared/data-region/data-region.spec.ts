import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Skeleton } from '../skeleton/skeleton';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { JobStatus } from '../job-status/job-status';
import { StaleBadge } from '../stale-badge/stale-badge';
import { OfflineBanner } from '../offline-banner/offline-banner';
import { DataRegion, type DataRegionState } from './data-region';

@Component({
  imports: [DataRegion],
  template: `
    <app-data-region
      [state]="state()"
      [skeletonRows]="2"
      loadingLabel="Loading devices."
      (retry)="retries = retries + 1"
      (refresh)="refreshes = refreshes + 1"
      (reconnect)="reconnects = reconnects + 1"
    >
      <p class="region-data">Cached records</p>
      <button dataRegionAction>Add record</button>
      <p dataRegionContext>Filter: active devices</p>
    </app-data-region>
  `,
})
class Host {
  readonly state = signal<DataRegionState>({ status: 'ready' });
  retries = 0;
  refreshes = 0;
  reconnects = 0;
}

describe('DataRegion', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
    }).compileComponents();
  });

  function create(state: DataRegionState) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.state.set(state);
    fixture.detectChanges();
    return fixture;
  }

  it('renders projected content in the ready state', () => {
    const fixture = create({ status: 'ready' });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.region-data')
        ?.textContent,
    ).toContain('Cached records');
    expect(fixture.debugElement.query(By.directive(Skeleton))).toBeNull();
  });

  it('renders a skeleton instead of content while loading', () => {
    const fixture = create({ status: 'loading' });
    expect(fixture.debugElement.query(By.directive(Skeleton))).toBeTruthy();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Loading devices.');
    expect(element.querySelector('.region-data')).toBeNull();
  });

  it('distinguishes no data from no matches in the empty state', () => {
    const noData = create({
      status: 'empty',
      reason: 'no-data',
      title: 'No devices',
    });
    expect(noData.debugElement.query(By.directive(EmptyState))).toBeTruthy();
    expect((noData.nativeElement as HTMLElement).textContent).toContain(
      'There are no records to show yet.',
    );
    const noMatches = create({
      status: 'empty',
      reason: 'no-matches',
      title: 'No devices',
    });
    expect((noMatches.nativeElement as HTMLElement).textContent).toContain(
      'No records match the active filters.',
    );
    expect(
      (noMatches.nativeElement as HTMLElement).querySelector(
        '[dataRegionAction]',
      ),
    ).toBeTruthy();
  });

  it('renders the error state with preserved context and emits retry', () => {
    const fixture = create({
      status: 'error',
      title: 'Devices unavailable',
      cause: 'The device service did not respond.',
      scope: 'Device inventory',
    });
    const errorState = fixture.debugElement.query(By.directive(ErrorState));
    expect(errorState).toBeTruthy();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('The device service did not respond.');
    expect(element.querySelector('[dataRegionContext]')?.textContent).toContain(
      'Filter: active devices',
    );
    (element.querySelector('app-error-state button') as HTMLButtonElement).click();
    expect(fixture.componentInstance.retries).toBe(1);
  });

  it('reports succeeded and failed counts while preserving partial content', () => {
    const fixture = create({ status: 'partial', succeeded: 8, failed: 2 });
    const jobStatus = fixture.debugElement.query(By.directive(JobStatus));
    expect(jobStatus).toBeTruthy();
    const instance = jobStatus.injector.get(JobStatus);
    expect(instance.succeeded()).toBe(8);
    expect(instance.failed()).toBe(2);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.region-data'),
    ).toBeTruthy();
  });

  it('keeps data visible with the stale badge and emits refresh', () => {
    const fixture = create({
      status: 'stale',
      observedAt: new Date(Date.now() - 600_000).toISOString(),
      staleAfterSeconds: 60,
    });
    expect(fixture.debugElement.query(By.directive(StaleBadge))).toBeTruthy();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Stale observation');
    expect(element.querySelector('.region-data')).toBeTruthy();
    (element.querySelector('app-stale-badge button') as HTMLButtonElement).click();
    expect(fixture.componentInstance.refreshes).toBe(1);
  });

  it('shows the offline banner, disables writes, and emits reconnect', () => {
    const fixture = create({
      status: 'offline',
      cachedAt: new Date().toISOString(),
    });
    expect(
      fixture.debugElement.query(By.directive(OfflineBanner)),
    ).toBeTruthy();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.region-data')).toBeTruthy();
    const region = fixture.debugElement.query(By.directive(DataRegion));
    expect(region.injector.get(DataRegion).writesDisabled()).toBe(true);
    expect(
      element.querySelector('.data-region-content')?.getAttribute(
        'aria-disabled',
      ),
    ).toBe('true');
    (element.querySelector('app-offline-banner button') as HTMLButtonElement).click();
    expect(fixture.componentInstance.reconnects).toBe(1);
  });

  it('keeps writes enabled outside the offline state', () => {
    const fixture = create({ status: 'ready' });
    const region = fixture.debugElement.query(By.directive(DataRegion));
    expect(region.injector.get(DataRegion).writesDisabled()).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.data-region-content')
        ?.getAttribute('aria-disabled'),
    ).toBeNull();
  });
});
