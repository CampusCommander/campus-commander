import {
  Component,
  afterNextRender,
  ElementRef,
  Injector,
  computed,
  effect,
  inject,
  OnDestroy,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { z } from 'zod';
import {
  customerSettingsSchema,
  customerSettingsWriteSchema,
  customerSettingsReceiptSchema,
  type CustomerState,
  type CustomerSettingsReceipt,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { CustomerStore } from './customer.store';

type PendingSave = z.infer<typeof customerSettingsWriteSchema>;

@Component({
  selector: 'app-customer-settings',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './customer-settings.html',
  styleUrl: './customer-settings.css',
})
export class CustomerSettingsPage implements OnDestroy, OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly store = inject(CustomerStore);
  protected readonly name = signal('');
  protected readonly baseRevision = signal<number | null>(null);
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);
  protected readonly pending = signal<PendingSave | null>(null);
  protected readonly receipt = signal<CustomerSettingsReceipt | null>(null);
  protected readonly conflict = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly storageError = signal('');
  protected readonly canWrite = computed(() => {
    const customer = this.store.customer();
    return (
      !!customer &&
      !this.auth.interrupted() &&
      this.auth.can('customer:write', {
        kind: 'district',
        customerId: customer.customerId,
      })
    );
  });
  protected readonly valid = computed(
    () =>
      customerSettingsSchema.safeParse({ displayName: this.name() }).success,
  );
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly principal = this.auth.session()?.identity.id ?? '';
  private readonly storageKey = `cc.customer-settings.pending.${this.principal}`;
  private operation = 0;
  private destroyed = false;
  private sessionKey = '';

  constructor() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (raw) {
        const saved = customerSettingsWriteSchema.parse(JSON.parse(raw));
        this.pending.set(saved);
        this.name.set(saved.settings.displayName);
        this.baseRevision.set(saved.expectedRevision);
        this.dirty.set(true);
      }
    } catch {
      this.storageError.set(
        'This tab cannot restore its pending save. Refresh saved settings before editing.',
      );
    }
    effect(() => {
      const session = this.auth.session();
      const key =
        !this.auth.interrupted() && session
          ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}`
          : '';
      if (key === this.sessionKey) return;
      this.sessionKey = key;
      untracked(() => {
        this.operation += 1;
        this.busy.set(false);
        if (this.pending())
          this.message.set(
            'We have not received a save confirmation. Check the save status before editing.',
          );
      });
    });
    effect(() => {
      const customer = this.store.customer();
      untracked(() => {
        if (!customer || this.dirty() || this.pending()) return;
        this.load(customer);
      });
    });
  }

  ngOnInit() {
    void this.store.refresh();
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.operation += 1;
  }

  private focusResult(operation: number, target?: string) {
    afterNextRender(
      () => {
        if (this.destroyed || operation !== this.operation) return;
        const selector =
          target ??
          (this.receipt()
            ? '#receipt-title'
            : this.pending()
              ? '#pending-title'
              : this.conflict()
                ? '#conflict-title'
                : '#settings-status');
        this.element.nativeElement
          .querySelector<HTMLElement>(selector)
          ?.focus();
      },
      { injector: this.injector },
    );
  }

  protected async viewReceipt() {
    const customer = this.store.customer();
    if (
      !customer?.lastRequestId ||
      this.busy() ||
      this.auth.interrupted() ||
      !this.store.readable()
    )
      return;
    const operation = ++this.operation;
    const csrf = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    this.message.set('Loading the last save.');
    try {
      const response = await this.auth.request(
        `/api/customer/receipts/${customer.lastRequestId}`,
      );
      const body: unknown = await response.json();
      if (!this.current(operation, csrf)) return;
      if (!response.ok) throw new Error();
      const receipt = customerSettingsReceiptSchema.parse(body);
      if (
        receipt.requestId !== customer.lastRequestId ||
        receipt.customerId !== customer.customerId
      )
        throw new Error();
      this.receipt.set(receipt);
      this.message.set('Last save loaded. Your edits are still in the form.');
    } catch {
      if (this.current(operation, csrf))
        this.error.set(
          'The last save details are unavailable. Check your connection and account access, then try again.',
        );
    } finally {
      if (operation === this.operation) {
        this.busy.set(false);
        this.focusResult(operation);
      }
    }
  }

  protected edit(value: string) {
    this.name.set(value);
    this.dirty.set(true);
    this.receipt.set(null);
  }

  private load(customer: CustomerState) {
    this.name.set(customer.settings.displayName);
    this.baseRevision.set(customer.revision);
    this.dirty.set(false);
  }

  protected useLatest(keepName: boolean) {
    const customer = this.store.customer();
    if (!customer || this.store.stale() || this.busy() || this.pending())
      return;
    if (keepName) this.baseRevision.set(customer.revision);
    else this.load(customer);
    this.conflict.set(false);
    this.focusResult(this.operation, 'input[name="displayName"]');
    this.error.set('');
    this.message.set(
      keepName
        ? 'Check your edited name, then save when you are ready.'
        : 'Loaded the saved customer name.',
    );
  }

  private persistPending(value: PendingSave | null) {
    this.pending.set(value);
    try {
      if (value) sessionStorage.setItem(this.storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(this.storageKey);
      this.storageError.set('');
    } catch {
      this.storageError.set(
        'Tab storage is unavailable. Keep this page open until the save result is confirmed.',
      );
    }
  }

  private current(operation: number, csrf: string | undefined) {
    return (
      !this.destroyed &&
      operation === this.operation &&
      !this.auth.interrupted() &&
      this.auth.session()?.identity.id === this.principal &&
      csrf === this.auth.session()?.csrfToken
    );
  }

  protected async save() {
    const customer = this.store.customer();
    if (
      !customer ||
      !this.canWrite() ||
      this.busy() ||
      this.store.stale() ||
      this.store.loading() ||
      this.conflict()
    )
      return;
    const retry = !!this.pending();
    let input = this.pending();
    if (input && input.customerId !== customer.customerId) {
      this.error.set(
        'The pending save belongs to another customer. Contact the installation operator.',
      );
      return;
    }
    if (!input) {
      const parsed = customerSettingsWriteSchema.safeParse({
        requestId: crypto.randomUUID(),
        customerId: customer.customerId,
        expectedRevision: this.baseRevision(),
        settings: { displayName: this.name() },
      });
      if (!parsed.success) {
        this.error.set(
          'Enter a customer name of 1–256 characters without control characters.',
        );
        return;
      }
      input = parsed.data;
      this.persistPending(input);
    }
    const operation = ++this.operation;
    const csrf = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    this.receipt.set(null);
    this.message.set('Saving customer settings.');
    this.focusResult(operation);
    try {
      const response = await this.auth.request('/api/customer/settings', input);
      const body: unknown = await response.json();
      if (!this.current(operation, csrf)) return;
      if (response.ok) await this.acceptReceipt(body, input);
      else if (response.status === 409) {
        this.persistPending(null);
        this.conflict.set(true);
        this.message.set('');
        this.error.set(
          'The saved settings changed or this request conflicts with an earlier save. Refresh and review the latest name.',
        );
        await this.store.refresh();
      } else if (
        !retry &&
        (response.status === 400 || response.status === 403)
      ) {
        this.persistPending(null);
        this.message.set('');
        this.error.set(
          response.status === 403
            ? 'You do not have permission to save these settings. Your edited name is still in the form.'
            : 'The settings are invalid. Check the customer name and retry.',
        );
      } else throw new Error();
    } catch {
      if (this.current(operation, csrf)) {
        this.message.set('');
        this.error.set(
          'We have not received a save confirmation. Check the save status before editing.',
        );
      }
    } finally {
      if (operation === this.operation) {
        this.busy.set(false);
        this.focusResult(operation);
      }
    }
  }

  protected async checkReceipt() {
    const input = this.pending();
    if (
      !input ||
      this.busy() ||
      !this.store.readable() ||
      this.auth.interrupted()
    )
      return;
    const operation = ++this.operation;
    const csrf = this.auth.session()?.csrfToken;
    this.busy.set(true);
    this.error.set('');
    this.message.set('Checking the save receipt.');
    try {
      const response = await this.auth.request(
        `/api/customer/receipts/${input.requestId}`,
      );
      const body: unknown = await response.json();
      if (!this.current(operation, csrf)) return;
      if (response.ok) await this.acceptReceipt(body, input);
      else if (response.status === 404)
        this.message.set(
          'The save is not confirmed yet. Select Retry save to try again.',
        );
      else throw new Error();
    } catch {
      if (this.current(operation, csrf)) {
        this.message.set('');
        this.error.set(
          'The save status is unavailable. Check your connection and account access, then try again.',
        );
      }
    } finally {
      if (operation === this.operation) {
        this.busy.set(false);
        this.focusResult(operation);
      }
    }
  }

  private async acceptReceipt(body: unknown, input: PendingSave) {
    const receipt = customerSettingsReceiptSchema.parse(body);
    if (
      receipt.requestId !== input.requestId ||
      receipt.customerId !== input.customerId ||
      receipt.revision !== input.expectedRevision + 1 ||
      receipt.settings.displayName !== input.settings.displayName
    )
      throw new Error();
    this.receipt.set(receipt);
    this.name.set(receipt.settings.displayName);
    this.baseRevision.set(receipt.revision);
    this.dirty.set(false);
    this.conflict.set(false);
    this.persistPending(null);
    this.message.set('Customer settings saved.');
    await this.store.refresh();
  }
}
