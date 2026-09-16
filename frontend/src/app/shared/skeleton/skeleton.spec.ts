import { TestBed } from '@angular/core/testing';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Skeleton],
    }).compileComponents();
  });

  it('renders three row blocks by default', () => {
    const fixture = TestBed.createComponent(Skeleton);
    fixture.detectChanges();
    const blocks = fixture.nativeElement.querySelectorAll('.skeleton-block');
    expect(blocks.length).toBe(3);
    expect(
      fixture.nativeElement.querySelectorAll('.skeleton-line').length,
    ).toBe(0);
  });

  it('renders the requested number of blocks', () => {
    const fixture = TestBed.createComponent(Skeleton);
    fixture.componentRef.setInput('rows', 5);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('.skeleton-block').length,
    ).toBe(5);
  });

  it('renders line blocks for the lines variant', () => {
    const fixture = TestBed.createComponent(Skeleton);
    fixture.componentRef.setInput('variant', 'lines');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('.skeleton-line').length,
    ).toBe(3);
  });

  it('renders an avatar block when requested', () => {
    const fixture = TestBed.createComponent(Skeleton);
    fixture.componentRef.setInput('avatar', true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelectorAll('.skeleton-avatar').length,
    ).toBe(1);
    expect(
      fixture.nativeElement.querySelectorAll('.skeleton-block').length,
    ).toBe(4);
  });

  it('hides placeholder blocks from assistive technology', () => {
    const fixture = TestBed.createComponent(Skeleton);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.skeleton')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });
});
