import { Injectable, inject } from '@angular/core';
import {
  deviceActionJobReceiptSchema,
  deviceActionPreviewSchema,
  deviceActionTargetsPageSchema,
  type DeviceAction,
  type DeviceActionJobReceipt,
  type DeviceActionPreview,
  type DeviceActionPreviewRequest,
  type DeviceActionTarget,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import type { DeviceActionFamily } from './device-action-messages';
import { DEVICE_GRID_ID } from './device-selection';
import { flowAnswer, flowExpiry, type FlowRead } from './device-update-flow';
import { DevicesStore } from './devices.store';

/** The route family of each Bulk Actions entry (design section 7). */
export function actionFamilyPath(family: DeviceActionFamily): string {
  return family === 'command'
    ? '/api/devices/commands'
    : '/api/devices/status-changes';
}

/**
 * The preview, target, and confirmation reads of a command or status sheet. The
 * sheets own the step state and the display context. Each answer maps to one page
 * state, as the step 4 flow does.
 */
@Injectable({ providedIn: 'root' })
export class DeviceActionFlow {
  private readonly auth = inject(AuthStore);
  private readonly devices = inject(DevicesStore);

  /** The preview body of section 7. It carries the selection key and the action. */
  private body(action: DeviceAction): DeviceActionPreviewRequest {
    const key = {
      gridId: DEVICE_GRID_ID,
      tabId: this.devices.selectionTab,
    };
    switch (action) {
      case 'reboot':
        return { ...key, commandType: 'REBOOT' };
      case 'wipe-users':
        return { ...key, commandType: 'WIPE_USERS' };
      case 'powerwash':
        return { ...key, commandType: 'REMOTE_POWERWASH' };
      case 'disable':
      case 'reenable':
        return { ...key, statusAction: action };
      case 'deprovision':
        // Card F1 collects the reason. The sheets of the first build never offer Deprovision.
        throw new Error(
          'A Deprovision preview needs a reason that this sheet does not collect.',
        );
    }
  }

  /** Prepare a frozen preview from the stored selection. */
  async prepare(
    family: DeviceActionFamily,
    action: DeviceAction,
  ): Promise<FlowRead<DeviceActionPreview>> {
    try {
      const response = await this.auth.request(
        `${actionFamilyPath(family)}/previews`,
        this.body(action),
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const preview = deviceActionPreviewSchema.safeParse(body);
        return preview.success
          ? { ok: true, value: preview.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /** The frozen summary of one preview. */
  async readPreview(
    family: DeviceActionFamily,
    previewId: string,
  ): Promise<FlowRead<DeviceActionPreview>> {
    try {
      const response = await this.auth.request(
        `${actionFamilyPath(family)}/previews/${encodeURIComponent(previewId)}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const preview = deviceActionPreviewSchema.safeParse(body);
        return preview.success
          ? { ok: true, value: preview.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /** One page of frozen targets. */
  async readTargetsPage(
    family: DeviceActionFamily,
    previewId: string,
    cursor: string | null,
  ): Promise<
    FlowRead<{ targets: DeviceActionTarget[]; nextCursor: string | null }>
  > {
    const query = new URLSearchParams({ limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await this.auth.request(
        `${actionFamilyPath(family)}/previews/${encodeURIComponent(previewId)}/targets?${query}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const page = deviceActionTargetsPageSchema.safeParse(body);
        return page.success
          ? { ok: true, value: page.data }
          : { ok: false, answer: 'preview-unavailable', expiresAt: null };
      }
      return this.failure(response.status, body);
    } catch {
      return { ok: false, answer: 'offline', expiresAt: null };
    }
  }

  /** Every frozen target, in ordinal order, through the route cursor. */
  async readTargets(
    family: DeviceActionFamily,
    previewId: string,
    cursor: string | null = null,
  ): Promise<FlowRead<DeviceActionTarget[]>> {
    const targets: DeviceActionTarget[] = [];
    let next: string | null = cursor;
    do {
      const page = await this.readTargetsPage(family, previewId, next);
      if (!page.ok) return page;
      targets.push(...page.value.targets);
      next = page.value.nextCursor;
    } while (next);
    return { ok: true, value: targets };
  }

  /**
   * The confirmation of section 7. A duplicate answer returns the same receipt. An
   * answer that names no state leaves acceptance unknown, because the request may
   * have committed before the answer was lost.
   */
  async confirm(
    family: DeviceActionFamily,
    previewId: string,
    manifestDigest: string,
  ): Promise<FlowRead<DeviceActionJobReceipt>> {
    try {
      const response = await this.auth.request(
        `${actionFamilyPath(family)}/previews/${encodeURIComponent(previewId)}/confirm`,
        { manifestDigest, acknowledged: true },
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const receipt = deviceActionJobReceiptSchema.safeParse(body);
        return receipt.success
          ? { ok: true, value: receipt.data }
          : { ok: false, answer: 'confirm-uncertain', expiresAt: null };
      }
      return {
        ok: false,
        answer: flowAnswer(response.status, body) ?? 'confirm-uncertain',
        expiresAt: flowExpiry(body),
      };
    } catch {
      return { ok: false, answer: 'confirm-uncertain', expiresAt: null };
    }
  }

  private failure(
    status: number,
    body: unknown,
    fallback: 'preview-unavailable' = 'preview-unavailable',
  ): FlowRead<never> {
    return {
      ok: false,
      answer: flowAnswer(status, body) ?? fallback,
      expiresAt: flowExpiry(body),
    };
  }
}
