import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { OuReferencePicker } from '../schools/ou-reference-picker';
import type { OrgUnitTreeRow } from './device-org-unit-tree.store';
import { deviceCountText } from './device-update-messages';

/**
 * The organization unit picker dialog (Figma 171:1283, design section 6). It holds the
 * shared tree (TREE-01), searches it by path, and returns one unit. The sheet owns the
 * draft; this dialog only reports the choice.
 */
@Component({
  selector: 'app-device-org-unit-picker',
  imports: [
    FormsModule,
    CdkTrapFocus,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    OuReferencePicker,
  ],
  templateUrl: './device-org-unit-picker.html',
  styleUrls: ['./device-dialog.css', './device-org-unit-picker.css'],
})
export class DeviceOrgUnitPicker {
  readonly open = input.required<boolean>();
  /** The whole tree while the read is granted. */
  readonly units = input.required<OrgUnitTreeRow[]>();
  /** The selected devices, as the current line counts them. */
  readonly deviceCount = input.required<number>();
  /** The unit to highlight when the dialog opens again. */
  readonly selectedId = input<string | null>(null);
  /** Replaces the count line, so the grid can name the cell that opened the dialog. */
  readonly contextLine = input<string | null>(null);
  /** The confirm action. The sheet chooses, and the grid stages a change. */
  readonly confirmLabel = input('Choose');
  readonly cancelled = output<void>();
  readonly chosen = output<OrgUnitTreeRow>();

  protected readonly query = signal('');
  private readonly highlightedId = signal<string | null>(null);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly injector = inject(Injector);
  protected readonly countLine = computed(() =>
    deviceCountText(this.deviceCount()),
  );
  protected readonly highlighted = computed<OrgUnitTreeRow | null>(
    () => this.units().find((unit) => unit.id === this.highlightedId()) ?? null,
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.query.set('');
        this.highlightedId.set(this.selectedId());
        afterNextRender(
          () => {
            const search = this.search()?.nativeElement;
            search?.focus({ preventScroll: true });
          },
          { injector: this.injector },
        );
      });
    });
  }

  protected select(id: string): void {
    this.highlightedId.set(id);
  }

  protected choose(): void {
    const unit = this.highlighted();
    if (unit) this.chosen.emit(unit);
  }

  protected cancel(): void {
    this.cancelled.emit();
  }

  /** Escape closes the dialog before the sheet reads the same event. */
  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  }
}
