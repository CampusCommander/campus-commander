import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { DeviceUpdateMode } from '@campus/application-contracts';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { problemSummary, type FlowProblemKind } from './device-update-flow';
import { DeviceUpdateConfirmationStore } from './device-update-confirmation.store';
import {
  deviceCountText,
  deviceUpdateValueError,
  changedFieldsText,
} from './device-update-messages';
import { DEVICE_GRID_ID } from './device-selection';
import { DevicesStore } from './devices.store';

@Component({
  selector: 'app-device-update',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './device-update.html',
  styleUrl: './device-update.css',
})
export class DeviceUpdatePage implements OnInit {
  protected readonly store = inject(DevicesStore);
  protected readonly draft = inject(DeviceUpdateDraftStore);
  private readonly confirmations = inject(DeviceUpdateConfirmationStore);
  private readonly router = inject(Router);
  protected readonly loading = signal(true);
  protected readonly count = signal<number | null>(null);
  protected readonly expired = signal(false);
  protected readonly selectionError = signal('');
  protected readonly offline = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly attempted = signal(false);
  protected readonly valueError = computed(() =>
    this.draft.mode() === 'replace'
      ? deviceUpdateValueError(this.draft.value())
      : null,
  );
  /** The error appears after typing an invalid value or after a save attempt. */
  protected readonly showValueError = computed(
    () =>
      !!this.valueError() &&
      (this.draft.value().length > 0 || this.attempted()),
  );
  protected readonly length = computed(() => [...this.draft.value()].length);
  protected readonly title = computed(() => {
    if (this.expired()) return 'Selection expired';
    const count = this.count();
    return count === null
      ? 'Update devices'
      : `Update ${deviceCountText(count)}`;
  });
  protected readonly subtitle = computed(() =>
    this.expired() ? 'No job created' : 'Draft changes · Not submitted',
  );
  protected readonly summary = computed(
    () =>
      `${deviceCountText(this.count() ?? 0)} · ${changedFieldsText(
        this.draft.changed() ? 1 : 0,
      )} · Not submitted`,
  );
  protected readonly canSave = computed(
    () =>
      !this.loading() &&
      !this.expired() &&
      !this.selectionError() &&
      !this.offline() &&
      !this.saving() &&
      (this.count() ?? 0) > 0 &&
      this.valueError() === null,
  );
  private readonly key = {
    gridId: DEVICE_GRID_ID,
    tabId: this.store.selectionTab,
  };

  ngOnInit(): void {
    void this.load();
  }

  /** Read the stored selection. It reports the count and an expired selection. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.selectionError.set('');
    this.offline.set(false);
    this.expired.set(false);
    try {
      await this.store.selection.getSpec(this.key);
      const spec = this.store.selection.spec();
      this.count.set(spec?.selectedCount ?? 0);
      if (spec?.expiredAt) this.expired.set(true);
    } catch {
      if (this.store.offline()) this.offline.set(true);
      else
        this.selectionError.set(
          'Campus Commander could not read the device selection.',
        );
    } finally {
      this.loading.set(false);
    }
  }

  protected reset(): void {
    this.attempted.set(false);
    this.saveError.set('');
    this.draft.reset();
  }

  protected setMode(mode: DeviceUpdateMode): void {
    this.draft.setMode(mode);
  }

  /** Show the selected devices in the grid and keep the draft (design 1759). */
  protected review(): void {
    this.store.selectedView.set(true);
    void this.router.navigate(['/devices']);
  }

  protected returnToDevices(): void {
    void this.router.navigate(['/devices']);
  }

  protected async preview(): Promise<void> {
    this.attempted.set(true);
    if (!this.canSave()) return;
    this.saving.set(true);
    this.saveError.set('');
    const preparation = await this.confirmations.preparePreview();
    this.saving.set(false);
    if (preparation.kind === 'receipt') {
      await this.router.navigate([
        '/jobs',
        preparation.receipt.displayId,
        'receipt',
      ]);
      return;
    }
    if (preparation.kind === 'preview') {
      this.offline.set(false);
      await this.router.navigate([
        '/devices/update/previews',
        preparation.preview.previewId,
      ]);
      return;
    }
    if (preparation.kind === 'uncertain') {
      // The retained confirmation waits for its replay. The confirmation page owns
      // the uncertain state and its Retry, so this page does not create a preview.
      await this.router.navigate([
        '/devices/update/previews',
        preparation.submitted.previewId,
        'confirm',
      ]);
      return;
    }
    this.showPrepareProblem(preparation.answer);
  }

  /** The draft page keeps its own inline answers for a failed preview request. */
  private showPrepareProblem(answer: FlowProblemKind): void {
    if (answer === 'selection-expired') {
      this.expired.set(true);
      return;
    }
    if (answer === 'connection-required') {
      this.saveError.set(
        'Connect Google Workspace before you prepare an update preview.',
      );
      return;
    }
    if (answer === 'nothing-selected') {
      this.saveError.set(
        'No devices are selected. Return to Devices and select the devices again.',
      );
      return;
    }
    if (answer === 'selection-too-large') {
      this.saveError.set(
        'The selection holds more than 100,000 devices. Narrow the filters and select again.',
      );
      return;
    }
    if (answer === 'forbidden') {
      this.saveError.set('Your access changed. Update device is unavailable.');
      return;
    }
    if (answer === 'offline') {
      this.offline.set(true);
      this.saveError.set(
        'Cannot reach Campus Commander. Your draft stays in this tab.',
      );
      return;
    }
    this.saveError.set(problemSummary(answer));
  }
}
