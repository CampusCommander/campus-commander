import { Component, computed, input } from '@angular/core';

/**
 * Text that may hold an organization unit path. It adds a break opportunity after each
 * slash, as the approved screens show (design note 17). Other text renders unchanged.
 */
@Component({
  selector: 'app-device-path-text',
  // prettier-ignore
  template: `@for (part of parts(); track $index) {<span>{{ part }}</span><wbr />}`,
})
export class DevicePathText {
  readonly text = input.required<string>();
  /** The text cut after each slash. A text without a slash stays one part. */
  protected readonly parts = computed(() => this.text().split(/(?<=\/)/));
}
