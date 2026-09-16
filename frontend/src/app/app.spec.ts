import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Startup } from './startup/startup';

describe('Startup', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(new Error('Protected startup service unavailable')),
    );
    await TestBed.configureTestingModule({
      imports: [Startup],
    }).compileComponents();
  });

  it('renders truthful Phase 1 startup content', async () => {
    const fixture = TestBed.createComponent(Startup);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain(
      'Application service started',
    );
    expect(compiled.textContent).toContain('Frontend process running');
    expect(compiled.textContent).not.toContain('Sign in');
    await vi.waitFor(() => {
      expect(compiled.textContent).toContain('Installation status unavailable');
    });
  });

  it('renders observed protected startup checks', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          phase: 1,
          status: 'ready',
          checks: [{ name: 'database', status: 'ready' }],
        }),
        { status: 200 },
      ),
    );
    const fixture = TestBed.createComponent(Startup);
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(
        'Installation checks ready',
      );
      expect(fixture.nativeElement.textContent).toContain('database');
    });
  });
});
