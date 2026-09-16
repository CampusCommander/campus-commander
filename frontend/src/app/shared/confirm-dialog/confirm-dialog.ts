import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export type ConfirmLevel = 1 | 2 | 3;

export interface ConfirmDialogData {
  level: ConfirmLevel;
  action: string;
  objectLabel: string;
  count: number;
  consequence: string;
  previewSummary?: string;
  confirmPhrase?: string;
  confirmLabel?: string;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.css',
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<ConfirmDialog, boolean>);
  protected readonly acknowledged = signal(false);
  protected readonly typed = signal('');
  protected readonly title = computed(
    () => `${this.data.action} ${this.data.count} ${this.data.objectLabel}`,
  );
  protected readonly confirmText = computed(
    () => this.data.confirmLabel ?? this.title(),
  );
  protected readonly confirmed = computed(() => {
    if (this.data.level === 3)
      return this.typed() === (this.data.confirmPhrase ?? '');
    if (this.data.level === 2) return this.acknowledged();
    return true;
  });
  protected cancel() {
    this.dialogRef.close(false);
  }
  protected confirm() {
    if (this.confirmed()) this.dialogRef.close(true);
  }
}
