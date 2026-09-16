import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { vi } from 'vitest';
import { ConfirmDialog, ConfirmDialogData } from './confirm-dialog';

describe('ConfirmDialog', () => {
  async function create(data: ConfirmDialogData) {
    const dialogRef = { close: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ConfirmDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: dialogRef },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ConfirmDialog);
    fixture.detectChanges();
    return { fixture, dialogRef };
  }

  function confirmButton(fixture: {
    nativeElement: HTMLElement;
  }): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    return buttons[buttons.length - 1];
  }

  it('names the action and object with the exact count in the title', async () => {
    const { fixture } = await create({
      level: 1,
      action: 'Suspend',
      objectLabel: 'users',
      count: 24,
      consequence: 'Suspended users lose access until you restore them.',
    });
    expect(fixture.nativeElement.textContent).toContain('Suspend 24 users');
  });

  it('enables Level 1 confirmation without further steps and closes true', async () => {
    const { fixture, dialogRef } = await create({
      level: 1,
      action: 'Save',
      objectLabel: 'settings',
      count: 1,
      consequence: 'Save these settings.',
    });
    const button = confirmButton(fixture);
    expect(button.disabled).toBe(false);
    button.click();
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  it('closes false when the operator cancels', async () => {
    const { fixture, dialogRef } = await create({
      level: 1,
      action: 'Save',
      objectLabel: 'settings',
      count: 1,
      consequence: 'Save these settings.',
    });
    const cancel = fixture.nativeElement.querySelector('button');
    cancel.click();
    expect(dialogRef.close).toHaveBeenCalledWith(false);
  });

  it('gates Level 2 confirmation behind an explicit acknowledgment', async () => {
    const { fixture, dialogRef } = await create({
      level: 2,
      action: 'Update',
      objectLabel: 'devices',
      count: 48,
      consequence: 'Updated devices receive the staged values.',
      previewSummary: '48 devices will change. 2 devices are excluded.',
    });
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('This action affects exactly 48 devices.');
    expect(text).toContain('48 devices will change. 2 devices are excluded.');
    const button = confirmButton(fixture);
    expect(button.disabled).toBe(true);
    fixture.nativeElement
      .querySelector('mat-checkbox input')
      .click();
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  it('gates Level 3 confirmation behind the exact typed phrase', async () => {
    const { fixture, dialogRef } = await create({
      level: 3,
      action: 'Powerwash',
      objectLabel: 'devices',
      count: 3,
      consequence:
        'Powerwash removes local data, user and device policies, and enrollment.',
      previewSummary: '3 devices will leave active management.',
      confirmPhrase: 'Powerwash',
    });
    expect(fixture.nativeElement.textContent).toContain('Powerwash 3 devices');
    const button = confirmButton(fixture);
    expect(button.disabled).toBe(true);
    const input = fixture.nativeElement.querySelector(
      'input[matinput]',
    ) as HTMLInputElement;
    input.value = 'powerwash';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    input.value = 'Powerwash';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });
});
