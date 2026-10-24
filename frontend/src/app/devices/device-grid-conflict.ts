import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import {
  DEVICE_UPDATE_FIELD_LABELS,
  type DeviceUpdateField,
} from '@campus/application-contracts';
import type { DeviceGridDraftEntry } from './device-grid-draft.store';

const CONFLICT_TITLES: Record<DeviceUpdateField, string> = {
  annotatedAssetId: 'The asset tag changed after you began editing',
  annotatedLocation: 'The location changed after you began editing',
  annotatedUser: 'The annotated user changed after you began editing',
  notes: 'The notes changed after you began editing',
  orgUnitPath: 'The organization unit changed after you began editing',
};

/** The two-way choice for a conflict cell (mockup state 06). */
@Component({
  selector: 'app-device-grid-conflict',
  imports: [A11yModule, MatButtonModule],
  templateUrl: './device-grid-conflict.html',
  styleUrl: './device-grid-conflict.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'device-grid-conflict' },
})
export class DeviceGridConflict {
  readonly entry = input.required<DeviceGridDraftEntry>();
  readonly left = input(0);
  readonly top = input(0);
  readonly keepCurrent = output<void>();
  readonly keepDraft = output<void>();
  readonly closed = output<void>();

  private readonly firstAction =
    viewChild<ElementRef<HTMLButtonElement>>('firstAction');

  protected readonly title = computed(
    () => CONFLICT_TITLES[this.entry().field],
  );
  protected readonly label = computed(
    () => DEVICE_UPDATE_FIELD_LABELS[this.entry().field],
  );

  constructor() {
    afterNextRender(() => this.firstAction()?.nativeElement.focus());
  }

  protected value(value: string | null | undefined): string {
    return value === null || value === undefined || value === ''
      ? 'No value'
      : value;
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  }

  protected close(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.closed.emit();
  }
}
