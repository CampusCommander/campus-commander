import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import type { UserAttributeDraftEntry } from './user-attribute-grid-draft';
import {
  attributeCellCounter,
  attributeCellStateText,
  attributeDraftValueText,
} from './user-attribute-grid-messages';

/** The parameters that the editable attribute columns pass to this renderer. */
export interface UserAttributeDraftCellParams
  extends ICellRendererParams<UserRow, string> {
  /** The C1 attribute ID of the column (design C1). */
  attribute: string;
  label: string;
  entryFor: (userId: string) => UserAttributeDraftEntry | null;
  reasonFor: (entry: UserAttributeDraftEntry) => string;
  editable: () => boolean;
  onRevert: (userId: string) => void;
}

function readable(value: string): string {
  return value === '' ? 'No value' : value;
}

/**
 * One editable attribute cell (DRAFT-02, design K26).
 *
 * The cell shows the pending draft value over the row value, marks the pending, invalid, or
 * conflict state, and offers the per-cell rollback icon. The editor itself is the AG Grid
 * editor of the attribute's info type; this renderer draws the resting cell only.
 */
@Component({
  selector: 'app-user-attribute-draft-cell',
  templateUrl: './user-attribute-draft-cell.html',
  styleUrl: './user-attribute-draft-cell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserAttributeDraftCell implements ICellRendererAngularComp {
  private readonly params = signal<UserAttributeDraftCellParams | null>(null);

  protected readonly data = computed(() => this.params()?.data ?? null);
  protected readonly label = computed(() => this.params()?.label ?? '');
  protected readonly text = computed(() => {
    const value = this.params()?.value;
    return value === null || value === undefined ? '' : String(value);
  });
  protected readonly entry = computed(() => {
    const params = this.params();
    if (!params?.data || params.node?.group) return null;
    return params.entryFor(params.data.userId);
  });
  protected readonly editable = computed(
    () => this.params()?.editable() ?? false,
  );
  protected readonly reason = computed(() => {
    const entry = this.entry();
    return entry ? (this.params()?.reasonFor(entry) ?? '') : '';
  });
  /** The tooltip of the error icon: the count of a long text, else the rule. */
  protected readonly errorTitle = computed(() => {
    const entry = this.entry();
    if (!entry) return '';
    return attributeCellCounter(entry.fieldType, entry.value) || this.reason();
  });
  /** The baseline and current value texts of the state announcement. */
  private readonly baselineText = computed(() => {
    const entry = this.entry();
    return entry
      ? readable(attributeDraftValueText(entry.baseline, entry.fieldType))
      : '';
  });
  private readonly currentText = computed(() => {
    const entry = this.entry();
    return entry
      ? readable(
          attributeDraftValueText(entry.currentValue ?? null, entry.fieldType),
        )
      : '';
  });
  protected readonly userName = computed(
    () => this.data()?.fullName || this.data()?.primaryEmail || 'this user',
  );
  protected readonly revertLabel = computed(
    () => `Revert ${this.label().toLowerCase()} of ${this.userName()}`,
  );
  protected readonly conflictTitle = computed(
    () =>
      `Conflict: ${this.label().toLowerCase()} changed in Google. Revert this change to save.`,
  );
  protected readonly stateText = computed(() => {
    const entry = this.entry();
    if (!entry) return '';
    return attributeCellStateText(entry.state, this.label(), {
      reason: this.reason(),
      baseline: this.baselineText(),
      currentValue: this.currentText(),
    });
  });

  agInit(params: UserAttributeDraftCellParams): void {
    this.params.set(params);
  }

  refresh(params: UserAttributeDraftCellParams): boolean {
    this.params.set(params);
    return true;
  }

  protected revert(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const params = this.params();
    if (params?.data) params.onRevert(params.data.userId);
  }
}
