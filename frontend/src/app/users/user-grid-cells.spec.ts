import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { IRowNode } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import { UserDetailsCell } from './user-details-cell';
import { UserNameCell } from './user-name-cell';

const row = (extra: Partial<UserRow> = {}): UserRow => ({
  userId: '110000000000000000001',
  primaryEmail: 'aaliyah.brooks@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Aaliyah',
  familyName: 'Brooks',
  fullName: 'Aaliyah Brooks',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: null,
  creationTime: null,
  twoStepEnrolled: false,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {},
  lastEntitySync: '2026-11-16T12:00:00.000Z',
  stale: false,
  recordVersion: 1,
  ...extra,
});

const node = { rowIndex: 4, group: false } as unknown as IRowNode<UserRow>;

function params(data: UserRow) {
  return {
    data,
    node,
    value: data.fullName ?? '',
    api: {} as never,
    context: {},
    colDef: { colId: 'details' },
    column: {} as never,
    rowIndex: 4,
    eGridCell: document.createElement('div'),
    eParentOfValue: document.createElement('span'),
    refreshCell: () => undefined,
    setValue: () => undefined,
    formatValue: () => undefined,
  };
}

describe('the users details control', () => {
  it('opens the user with an accessible name and tooltip', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const onDetails = vi.fn();
    const fixture = TestBed.createComponent(UserDetailsCell);
    fixture.componentInstance.agInit({
      ...params(row()),
      onDetails,
    } as never);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe(
      'Open details for Aaliyah Brooks',
    );
    expect(button.getAttribute('title')).toBe(
      'Open details for Aaliyah Brooks',
    );
    button.click();
    expect(onDetails).toHaveBeenCalledWith(row(), node);
  });

  it('names the email when Google holds no name', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(UserDetailsCell);
    fixture.componentInstance.agInit({
      ...params(row({ fullName: null })),
      onDetails: vi.fn(),
    } as never);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('button')
        ?.getAttribute('aria-label'),
    ).toBe('Open details for aaliyah.brooks@example.org');
  });

  it('does not open a row that holds no user', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const onDetails = vi.fn();
    const fixture = TestBed.createComponent(UserDetailsCell);
    fixture.componentInstance.agInit({
      ...params(row()),
      data: null,
      onDetails,
    } as never);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('button')?.click();
    expect(onDetails).not.toHaveBeenCalled();
  });
});

describe('the users name link', () => {
  it('links to the details page and records the row it opens', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const onOpen = vi.fn();
    const fixture = TestBed.createComponent(UserNameCell);
    fixture.componentInstance.agInit({
      ...params(row()),
      onOpen,
    } as never);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a',
    ) as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe('Aaliyah Brooks');
    expect(link.getAttribute('href')).toBe('/users/110000000000000000001');
    // The link hands the row to the page and the router carries the navigation.
    // A modified click leaves navigation to the router, so the test exercises the hand-off only.
    const noNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', noNavigation, {
      capture: true,
      once: true,
    });
    link.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
    expect(onOpen).toHaveBeenCalledWith(row(), node);
  });

  it('shows the email as its text when Google holds no name', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(UserNameCell);
    fixture.componentInstance.agInit({
      ...params(row({ fullName: null })),
      onOpen: vi.fn(),
    } as never);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a')?.textContent,
    ).toBe('aaliyah.brooks@example.org');
  });
});
