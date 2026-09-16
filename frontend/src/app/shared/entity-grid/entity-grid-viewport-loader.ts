import { Injectable, type Type } from '@angular/core';
import type { OutputEmitterRef } from '@angular/core';

/**
 * Outputs every entity grid viewport renderer must expose.
 * The qualified renderer is LibreGrid on AG Grid Community. It loads in a
 * lazy chunk so the grid library stays out of the initial bundle.
 */
export interface EntityGridViewportOutputs {
  detailsRequested: OutputEmitterRef<string>;
  rowSelectionChange: OutputEmitterRef<ReadonlySet<string>>;
}

@Injectable({ providedIn: 'root' })
export class EntityGridViewportLoader {
  async load(): Promise<Type<unknown>> {
    const module = await import('./libregrid-viewport');
    return module.LibreGridViewport;
  }
}
