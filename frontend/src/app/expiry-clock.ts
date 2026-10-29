import { DestroyRef, effect, inject, signal, type Signal } from '@angular/core';

/**
 * The longest delay a native timer accepts. A larger delay overflows and fires at once,
 * which would leave a 30-day file Ready past its deadline (UI-08).
 */
export const MAX_NATIVE_TIMER_MS = 2_147_483_647;

/**
 * A clock that changes when an ISO deadline passes (design section 9, states 05 and 08).
 *
 * A file card reads `now()` inside its computed view, so an expiry that passes while the
 * view stays open disables the download without a job event or a manual refresh. Call it
 * from an injection context, such as a component field initializer.
 *
 * A retention deadline is 30 days, beyond the native timer range. Each wait is bounded and
 * the clock arms the next wait until the deadline, so an early native wake never ends the
 * watch. A changed deadline or a destroyed host cancels the pending wait.
 */
export function expiryClock(deadline: () => string | null): Signal<number> {
  const now = signal(Date.now());
  const destroyRef = inject(DestroyRef);
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The deadline of the armed wait, or null when no wait runs. */
  let target: number | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Wakes at the deadline, or at the end of the native range, then arms the next wait. */
  const wake = () => {
    timer = null;
    if (target === null) return;
    const remaining = target - Date.now();
    if (!Number.isFinite(remaining)) {
      target = null;
      return;
    }
    if (remaining <= 0) {
      target = null;
      now.set(Date.now());
      return;
    }
    timer = setTimeout(wake, Math.min(remaining + 1, MAX_NATIVE_TIMER_MS));
  };

  effect(() => {
    const expiresAt = deadline();
    clear();
    target = null;
    if (!expiresAt) return;
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) return;
    if (at <= Date.now()) {
      now.set(Date.now());
      return;
    }
    target = at;
    wake();
  });
  destroyRef.onDestroy(() => {
    target = null;
    clear();
  });
  return now.asReadonly();
}
