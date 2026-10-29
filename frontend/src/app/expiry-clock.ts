import {
  DestroyRef,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';

/**
 * A clock that changes when an ISO deadline passes (design section 9, states 05 and 08).
 *
 * A file card reads `now()` inside its computed view, so an expiry that passes while the
 * view stays open disables the download without a job event or a manual refresh. Call it
 * from an injection context, such as a component field initializer.
 */
export function expiryClock(deadline: () => string | null): Signal<number> {
  const now = signal(Date.now());
  const destroyRef = inject(DestroyRef);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  effect(() => {
    const expiresAt = deadline();
    clear();
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    if (remaining <= 0) {
      now.set(Date.now());
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      now.set(Date.now());
    }, remaining + 1);
  });
  destroyRef.onDestroy(clear);
  return now.asReadonly();
}