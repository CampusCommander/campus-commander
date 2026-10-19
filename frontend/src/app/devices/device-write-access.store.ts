import { Injectable, computed, inject, signal } from '@angular/core';
import {
  deviceWriteAccessSchema,
  type DeviceWriteAccess,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DEVICE_WRITE_ACCESS_BUSY_MESSAGE } from './device-update-messages';

/** The cached write-access state of the connected customer (design 2.7). */
@Injectable({ providedIn: 'root' })
export class DeviceWriteAccessStore {
  private readonly auth = inject(AuthStore);
  readonly access = signal<DeviceWriteAccess | null>(null);
  readonly loading = signal(false);
  readonly checking = signal(false);
  /** A recovery message for the last read or check, such as the busy answer. */
  readonly message = signal('');
  readonly state = computed(() => this.access()?.state ?? null);
  private inFlight: Promise<DeviceWriteAccess | null> | null = null;

  /**
   * Read the current state. Each activation reads again, so a changed grant is
   * visible without a reload (design 2.7, 4.3). A second call while the read runs
   * shares its answer. A failed read leaves no usable state.
   */
  async load(): Promise<DeviceWriteAccess | null> {
    if (this.inFlight) return this.inFlight;
    this.loading.set(true);
    this.inFlight = this.read();
    const answer = await this.inFlight;
    this.inFlight = null;
    this.loading.set(false);
    return answer;
  }

  private async read(): Promise<DeviceWriteAccess | null> {
    try {
      const response = await this.auth.request('/api/devices/updates/access');
      if (!response.ok) {
        this.access.set(null);
        this.message.set(
          response.status === 403
            ? 'You do not have permission to change devices.'
            : 'Google write access is unavailable.',
        );
        return null;
      }
      const access = deviceWriteAccessSchema.safeParse(await response.json());
      if (!access.success) {
        this.access.set(null);
        this.message.set(
          'The Google write access answer was not readable. Check it again.',
        );
        return null;
      }
      this.message.set('');
      this.access.set(access.data);
      return access.data;
    } catch {
      this.access.set(null);
      this.message.set(
        'Cannot reach Campus Commander. Check Google write access when the connection returns.',
      );
      return null;
    }
  }

  /** Run the check again and keep its answer. A 429 answer reports the busy interval. */
  async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.message.set('');
    try {
      const response = await this.auth.request(
        '/api/devices/updates/access/check',
        {},
      );
      const body: unknown = await response.json().catch(() => null);
      if (
        response.status === 429 &&
        (body as { reason?: unknown } | null)?.reason === 'busy'
      ) {
        this.message.set(DEVICE_WRITE_ACCESS_BUSY_MESSAGE);
        return;
      }
      if (!response.ok) {
        this.message.set(
          response.status === 403
            ? 'You do not have permission to change devices.'
            : 'The Google write access check did not finish. Try again.',
        );
        return;
      }
      const access = deviceWriteAccessSchema.safeParse(body);
      if (!access.success) {
        this.message.set(
          'The Google write access check returned an unreadable answer. Try again.',
        );
        return;
      }
      this.access.set(access.data);
    } catch {
      this.message.set(
        'Cannot reach Campus Commander. Try again when the connection returns.',
      );
    } finally {
      this.checking.set(false);
    }
  }
}
