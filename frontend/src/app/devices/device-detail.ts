import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import type {
  DeviceBattery,
  DeviceDetail,
} from '@campus/application-contracts';
import { DevicesStore } from './devices.store';
import { batteryText, relativeTime } from './device-fields';

@Component({
  selector: 'app-device-detail',
  imports: [DatePipe, RouterLink, MatButtonModule],
  templateUrl: './device-detail.html',
  styleUrl: './device-detail.css',
})
export class DeviceDetailPage {
  readonly deviceId = input.required<string>();
  protected readonly store = inject(DevicesStore);
  private readonly router = inject(Router);
  protected readonly device = signal<DeviceDetail | null>(null);
  protected readonly status = signal<
    'loading' | 'ready' | 'missing' | 'offline'
  >('loading');
  protected readonly busy = signal(false);
  protected readonly hasNext = computed(() => {
    const position = this.store.position();
    const page = this.store.page();
    // Browser history can show another device than the remembered row.
    return (
      position !== null &&
      position.deviceId === this.deviceId() &&
      page !== null &&
      position.index + 1 < page.matching
    );
  });
  protected readonly relative = relativeTime;

  constructor() {
    effect(() => {
      const id = this.deviceId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    // Keep the current device visible while the next one loads, so focus stays on Next device.
    if (!this.device()) this.status.set('loading');
    this.busy.set(true);
    const device = await this.store.device(id);
    if (this.deviceId() !== id) return;
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
      index: position.index + 1,
      deviceId: row.deviceId,
    });
    await this.router.navigate(['/devices', row.deviceId]);
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
