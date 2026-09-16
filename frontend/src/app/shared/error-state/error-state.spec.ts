import { TestBed } from '@angular/core/testing';
import { ErrorState } from './error-state';

describe('ErrorState', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ErrorState],
    }).compileComponents();
  });

  function create() {
    const fixture = TestBed.createComponent(ErrorState);
    fixture.componentRef.setInput('title', 'Devices unavailable');
    fixture.componentRef.setInput(
      'cause',
      'The device service did not respond.',
    );
    return fixture;
  }

  it('renders the title, cause, and affected scope', () => {
    const fixture = create();
    fixture.componentRef.setInput('scope', 'Device inventory');
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Devices unavailable');
    expect(text).toContain('The device service did not respond.');
    expect(text).toContain('Affected: Device inventory');
  });

  it('announces the error through an alert region', () => {
    const fixture = create();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('emits retry when the operator selects Retry', () => {
    const fixture = create();
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.retry.subscribe(() => emitted++);
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    button.click();
    expect(emitted).toBe(1);
    expect(button.textContent).toContain('Retry');
  });

  it('disables Retry while a retry is in progress', () => {
    const fixture = create();
    fixture.componentRef.setInput('retrying', true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      'button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});
