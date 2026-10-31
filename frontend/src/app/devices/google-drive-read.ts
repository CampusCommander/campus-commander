import { Injectable } from '@angular/core';

/**
 * The browser reads of the Drive import header check
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, section 5, ruling 2).
 *
 * The browser reads the start of the chosen file through Google, with the one-hour `drive.file`
 * token and no cookie. A Sheet reads rows 1 and 2 of the chosen tab with formatted values. A CSV
 * file reads the first 64 KiB, the sample of the built check. The API reads its own facts; these
 * reads only feed the header check of the setup step.
 */

/** The bytes of the built CSV header sample (`fe/devices/device-import-messages.ts:36-37`). */
export const DRIVE_HEADER_SAMPLE_BYTES = 65_536;

/** The Sheets range of a header check: rows 1 and 2 across the usable width. */
export const DRIVE_SHEET_RANGE = 'A1:ZZ2';

/** A Google read of the chosen file failed. The status is the Google answer. */
export class DriveReadError extends Error {
  constructor(readonly status: number) {
    super(`drive-read-${status}`);
    this.name = 'DriveReadError';
  }
}

/** The Sheets and Drive reads of the browser header check (design section 5). */
@Injectable({ providedIn: 'root' })
export class GoogleDriveRead {
  /** Rows 1 and 2 of one tab, with formatted values (ruling 2). */
  async sheetRows(
    token: string,
    fileId: string,
    tabTitle: string,
  ): Promise<readonly (readonly string[])[]> {
    const sheet = tabTitle.replaceAll("'", "''");
    const range = encodeURIComponent(`'${sheet}'!${DRIVE_SHEET_RANGE}`);
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        fileId,
      )}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new DriveReadError(response.status);
    const answer: unknown = await response.json().catch(() => null);
    const values = (answer as { values?: unknown } | null)?.values;
    if (!Array.isArray(values)) return [];
    return values
      .filter((row): row is readonly unknown[] => Array.isArray(row))
      .map((row) =>
        row.map((cell) =>
          typeof cell === 'string'
            ? cell
            : cell === null || cell === undefined
              ? ''
              : String(cell),
        ),
      );
  }

  /** The first 64 KiB of a CSV file in Drive (ruling 2). */
  async fileHead(token: string, fileId: string): Promise<Uint8Array> {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId,
      )}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=0-${DRIVE_HEADER_SAMPLE_BYTES - 1}`,
        },
      },
    );
    if (!response.ok) throw new DriveReadError(response.status);
    return new Uint8Array(await response.arrayBuffer());
  }
}
