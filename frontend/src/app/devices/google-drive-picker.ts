import { Injectable } from '@angular/core';

/**
 * The Google Picker of the Drive import
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, section 5).
 *
 * Production loads the Picker script from Google and builds the Picker with the one-hour
 * `drive.file` token, the saved API key, and the project number. The view lists the person's
 * Google Sheets and CSV files in My Drive and allows one file. The browser sends only the chosen
 * file ID to the API.
 *
 * A test replaces the script through a Playwright route. No production source names the double
 * (`frontend-e2e/src/google-picker-double.js`).
 */

/** The one script URL of the Picker (design section 5, `td:1479`). */
export const PICKER_SCRIPT_URL = 'https://apis.google.com/js/api.js';

/** The two file types that the Picker lists (ruling 3). */
export const PICKER_MIME_TYPES =
  'application/vnd.google-apps.spreadsheet,text/csv';

/** The chosen file, from the Picker document. Display only: the API reads its own facts. */
export interface GooglePickerDocument {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  /** The Drive edit time in milliseconds since the epoch. */
  readonly lastEditedUtc: number | null;
}

/** One answer of the Picker callback (the Google Picker API). */
interface PickerAnswer {
  readonly action: string;
  readonly docs?: readonly {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly mimeType?: unknown;
    readonly sizeBytes?: unknown;
    readonly lastEditedUtc?: unknown;
  }[];
}

interface PickerDocsView {
  setIncludeFolders(value: boolean): PickerDocsView;
  setSelectFolderEnabled(value: boolean): PickerDocsView;
  setMimeTypes(value: string): PickerDocsView;
}

interface PickerBuilder {
  setAppId(value: string): PickerBuilder;
  setOAuthToken(value: string): PickerBuilder;
  setDeveloperKey(value: string): PickerBuilder;
  setOrigin(value: string): PickerBuilder;
  addView(view: PickerDocsView): PickerBuilder;
  setCallback(callback: (answer: PickerAnswer) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

interface GooglePickerApi {
  readonly PickerBuilder: new () => PickerBuilder;
  readonly DocsView: new (viewId: string) => PickerDocsView;
  readonly ViewId: { readonly DOCS: string };
  readonly Action: { readonly PICKED: string; readonly CANCEL: string };
}

interface GapiApi {
  load(module: string, options: { callback(): void; onerror?(): void }): void;
}

/** The globals that the Picker script installs on the page. */
interface PickerGlobals {
  gapi?: GapiApi;
  google?: { picker?: GooglePickerApi };
}

function globals(): PickerGlobals {
  return window as unknown as PickerGlobals;
}

/** A numeric value of a Picker document, or null when the field is absent. */
function numberOrNull(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** The chosen document of a Picker answer, or null when it carries none. */
function documentOf(
  doc: NonNullable<PickerAnswer['docs']>[number],
): GooglePickerDocument | null {
  const fileId = typeof doc.id === 'string' ? doc.id : '';
  const name = typeof doc.name === 'string' ? doc.name : '';
  const mimeType = typeof doc.mimeType === 'string' ? doc.mimeType : '';
  if (!fileId || !name || !mimeType) return null;
  return {
    fileId,
    name,
    mimeType,
    sizeBytes: numberOrNull(doc.sizeBytes),
    lastEditedUtc: numberOrNull(doc.lastEditedUtc),
  };
}

/** The real Picker loader and dialog of the Drive import (design section 5). */
@Injectable({ providedIn: 'root' })
export class GoogleDrivePicker {
  /** One script load per page, so a second open reuses the loaded module. */
  private script: Promise<void> | null = null;
  private loaded = false;

  /**
   * Open the Picker with the session token, the saved key, and the App ID. It answers the chosen
   * file, or null when the person cancels, closes, or presses Escape.
   */
  async open(
    token: string,
    apiKey: string,
    appId: string,
  ): Promise<GooglePickerDocument | null> {
    await this.load();
    const picker = globals().google?.picker;
    if (!picker) throw new Error('picker-unavailable');
    return new Promise<GooglePickerDocument | null>((resolve) => {
      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false)
        .setMimeTypes(PICKER_MIME_TYPES);
      const builder = new picker.PickerBuilder()
        .setAppId(appId)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setOrigin(window.location.origin)
        .addView(view)
        .setCallback((answer) => {
          if (answer.action === picker.Action.PICKED) {
            const doc = answer.docs?.[0];
            resolve(doc ? documentOf(doc) : null);
          } else if (answer.action === picker.Action.CANCEL) {
            resolve(null);
          }
        });
      builder.build().setVisible(true);
    });
  }

  /** Load `https://apis.google.com/js/api.js` once and its Picker module (design section 5). */
  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.script ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PICKER_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('picker-script'));
      document.head.appendChild(script);
    })
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const gapi = globals().gapi;
            if (!gapi) {
              reject(new Error('picker-script'));
              return;
            }
            gapi.load('picker', {
              callback: resolve,
              onerror: () => reject(new Error('picker-load')),
            });
          }),
      )
      .then(() => {
        this.loaded = true;
      })
      .catch((error: unknown) => {
        // A failed load leaves no script behind that a later open could reuse.
        this.script = null;
        throw error;
      });
    return this.script;
  }
}
