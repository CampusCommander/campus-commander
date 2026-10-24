import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import type {
  Action,
  DeviceBattery,
  DeviceDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';
import { DeviceUpdateSheet } from './device-update-sheet';
import { detailUpdateNote } from './device-update-messages';
import { batteryText, relativeTime } from './device-fields';

@Component({
  selector: 'app-device-detail',
  imports: [DatePipe, RouterLink, MatButtonModule, DeviceUpdateSheet],
  templateUrl: './device-detail.html',
  styleUrl: './device-detail.css',
})
export class DeviceDetailPage {
  readonly deviceId = input.required<string>();
  protected readonly store = inject(DevicesStore);
  protected readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly device = signal<DeviceDetail | null>(null);
  /** The one-device Update device sheet (addendum section 8). */
  protected readonly sheetOpen = signal(false);
  private readonly updateButton = viewChild('updateDevice', {
    read: ElementRef,
  });
  protected readonly status = signal<
    'loading' | 'ready' | 'missing' | 'offline'
  >('loading');
  protected readonly busy = signal(false);
  /** The three actions of Update device (`docs/ui/rules.md:73`). */
  protected readonly canRead = computed(() => this.authorized('devices:read'));
  protected readonly canWrite = computed(() =>
    this.authorized('devices:write'),
  );
  protected readonly canBulk = computed(() =>
    this.authorized('devices:bulk-actions'),
  );
  /** The reason that Update device is disabled, or null when it is enabled. */
  protected readonly updateNote = computed(() =>
    detailUpdateNote({
      offline: this.store.offline(),
      // The sync read supplies the customer scope that a grant names.
      permissionsKnown: !!this.store.sync(),
      canRead: this.canRead(),
      canWrite: this.canWrite(),
      canBulk: this.canBulk(),
    }),
  );
  /**
   * The note beside the Update device button. A route read keeps the previous device
   * visible, so the button waits for the device that the page will show (UI-05, UI-06, B1).
   */
  protected readonly updateBlockedNote = computed<string | null>(() =>
    this.busy() ? 'Loading device details…' : (this.updateNote()?.text ?? null),
  );
  protected readonly hasNext = computed(() => {
    const position = this.store.position();
    const page = this.store.page();
    // Browser history can show another device than the remembered row.
    return (
      position !== null &&
      position.deviceId === this.deviceId() &&
      page !== null &&
      // A device opened inside a group walks that group.
      position.index + 1 < (position.count ?? page.matching)
    );
  });
  protected readonly relative = relativeTime;

  constructor() {
    effect(() => {
      const id = this.deviceId();
      untracked(() => void this.load(id));
    });
  }

  /** Device details opens the sheet for the device that the page shows. */
  protected openSheet(): void {
    if (this.updateBlockedNote()) return;
    const shown = this.device();
    // A sheet opens only for the device whose values the page shows. A route read in flight
    // still shows the previous device, and its draft must not outlive that device (UI-06, B1).
    if (!shown || shown.deviceId !== this.deviceId()) return;
    this.sheetOpen.set(true);
  }

  /** Closing returns focus to the button that opened the sheet. */
  protected closeSheet(): void {
    this.sheetOpen.set(false);
    afterNextRender(() => this.updateButton()?.nativeElement?.focus(), {
      injector: this.injector,
    });
  }

  /** The receipt's Back to device reads the device again (Figma 116:299). */
  protected reloadAfterUpdate(): void {
    void this.load(this.deviceId());
  }

  private async load(id: string): Promise<void> {
    // A sheet belongs to the device that opened it. A route change closes it before the
    // page can show another device, so a draft never outlives its device (UI-06).
    if (this.sheetOpen() && this.device()?.deviceId !== id) this.closeSheet();
    // A direct link opens without the Devices page, so the permission scope reads here.
    if (!this.store.sync()) void this.store.loadSync();
    // Keep the current device visible while the next one loads, so focus stays on Next device.
    if (!this.device()) this.status.set('loading');
    this.busy.set(true);
    const device = await this.store.device(id);
    if (this.deviceId() !== id) return;
    // The displayed device changed, including a receipt-triggered read of another device.
    if (this.sheetOpen() && this.device()?.deviceId !== device?.deviceId)
      this.closeSheet();
    this.busy.set(false);
    this.device.set(device);
    this.status.set(
      device ? 'ready' : this.store.offline() ? 'offline' : 'missing',
    );
  }

  protected retry(): void {
    void this.load(this.deviceId());
  }

  protected async next(): Promise<void> {
    const position = this.store.position();
    if (position === null) return;
    const row = await this.store.neighbor(position.index + 1);
    if (!row) return;
    this.store.position.set({
      ...position,
      index: position.index + 1,
      deviceId: row.deviceId,
    });
    await this.router.navigate(['/devices', row.deviceId]);
  }

  /** One permission for the connected customer, as the Devices page reads it. */
  private authorized(action: Action): boolean {
    const customerId = this.store.sync()?.customerId;
    return (
      !!customerId && this.auth.can(action, { kind: 'district', customerId })
    );
  }

  protected identity(device: DeviceDetail): string {
    return (
      [device.model, device.assetTag].filter(Boolean).join(' · ') ||
      'ChromeOS device'
    );
  }

  protected healthClass(battery: DeviceBattery): string {
    if (battery.status !== 'reported') return '';
    return battery.health === 'normal'
      ? 'normal'
      : battery.health === 'replace-soon'
        ? 'soon'
        : 'now';
  }

  protected healthLabel(battery: DeviceBattery): string {
    return batteryText(battery);
  }

  protected capacityText(battery: DeviceBattery): string {
    return battery.status === 'reported' && battery.capacityPercent !== null
      ? `${battery.capacityPercent}% of design capacity`
      : 'Capacity not reported';
  }

  protected reportedAt(battery: DeviceBattery): string | null {
    return battery.status === 'reported' ? battery.reportedAt : null;
  }
}
