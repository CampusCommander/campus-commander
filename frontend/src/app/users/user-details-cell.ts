import { Component } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';

/**
 * GRID-03 details icon of the users grid.
 *
 * The users details page arrives with card K11. Until then the icon draws the row
 * marker and is not a control, so no click leads to a missing page.
 * The eye is inline SVG: the icon font painted a stray ellipsis under the glyph in
 * the grid cell, and the marker must match the approved screen exactly.
 */
@Component({
  selector: 'app-user-details-cell',
  template: `
    <span class="details-mark">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
      >
        <path
          d="M2.2 12s3.5-6.2 9.8-6.2S21.8 12 21.8 12s-3.5 6.2-9.8 6.2S2.2 12 2.2 12Z"
        />
        <circle cx="12" cy="12" r="3.1" />
      </svg>
    </span>
  `,
  styles: `
    .details-mark {
      display: inline-flex;
      align-items: center;
      color: var(--cc-text-link);
    }
    .details-mark svg {
      width: 24px;
      height: 24px;
      display: block;
    }
  `,
})
export class UserDetailsCell implements ICellRendererAngularComp {
  agInit(): void {
    // The icon carries no data until the details page lands (card K11).
  }

  refresh(): boolean {
    return true;
  }
}
