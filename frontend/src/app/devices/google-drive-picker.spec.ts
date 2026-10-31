import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleDrivePicker,
  PICKER_SCRIPT_URL,
  PICKER_MIME_TYPES,
} from './google-drive-picker';

/**
 * The production Picker loader (design section 5, C2). The page loads the one Google script from
 * `https://apis.google.com/js/api.js`; the browser suite answers that URL with its own double.
 */

interface PickerConfig {
  token: string;
  apiKey: string;
  appId: string;
  origin: string;
  mimeTypes: string[];
  ownedByMe: boolean;
  callback: (answer: unknown) => void;
}

const windows = window as unknown as {
  gapi?: unknown;
  google?: unknown;
};

function stubPicker(answer: unknown): PickerConfig[] {
  const configs: PickerConfig[] = [];
  windows.gapi = {
    load: (_module: string, options: { callback: () => void }) =>
      options.callback(),
  };
  windows.google = {
    picker: {
      ViewId: { DOCS: 'docs' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
      DocsView: class {
        readonly mimeTypes = PICKER_MIME_TYPES;
        ownedByMe = false;
        setIncludeFolders() {
          return this;
        }
        setSelectFolderEnabled() {
          return this;
        }
        setMimeTypes() {
          return this;
        }
        setOwnedByMe(value: boolean) {
          this.ownedByMe = value;
          return this;
        }
      },
      PickerBuilder: class {
        private readonly config: Partial<PickerConfig> = {};
        setAppId(value: string) {
          this.config.appId = value;
          return this;
        }
        setOAuthToken(value: string) {
          this.config.token = value;
          return this;
        }
        setDeveloperKey(value: string) {
          this.config.apiKey = value;
          return this;
        }
        setOrigin(value: string) {
          this.config.origin = value;
          return this;
        }
        addView(view: { mimeTypes: string; ownedByMe: boolean }) {
          this.config.mimeTypes = [view.mimeTypes];
          this.config.ownedByMe = view.ownedByMe;
          return this;
        }
        setCallback(value: (answer: unknown) => void) {
          this.config.callback = value;
          return this;
        }
        build() {
          const config = this.config as PickerConfig;
          return {
            setVisible: () => {
              configs.push(config);
              config.callback(answer);
            },
          };
        }
      },
    },
  };
  return configs;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete windows.gapi;
  delete windows.google;
});

describe('GoogleDrivePicker', () => {
  it('loads the real Google script once and opens with the session values (C2)', async () => {
    const script = vi
      .spyOn(document.head, 'appendChild')
      .mockImplementation((node: Node) => {
        queueMicrotask(() =>
          (node as HTMLScriptElement).onload?.(new Event('load')),
        );
        return node;
      });
    const configs = stubPicker({
      action: 'picked',
      docs: [
        {
          id: 'drive-file-1',
          name: 'devices.csv',
          mimeType: 'text/csv',
          sizeBytes: 12,
          lastEditedUtc: 1,
        },
      ],
    });
    const picker = new GoogleDrivePicker();
    const chosen = await picker.open(
      'example-token',
      'example-key',
      '123456789012',
    );
    expect(script).toHaveBeenCalledTimes(1);
    const node = script.mock.calls[0][0] as HTMLScriptElement;
    expect(node.src).toBe(PICKER_SCRIPT_URL);
    expect(node.src).toBe('https://apis.google.com/js/api.js');
    expect(configs[0]).toMatchObject({
      token: 'example-token',
      apiKey: 'example-key',
      appId: '123456789012',
      origin: window.location.origin,
      mimeTypes: [PICKER_MIME_TYPES],
      // Ruling 3: the view lists the owned files, never the shared ones (B4).
      ownedByMe: true,
    });
    expect(chosen).toEqual({
      fileId: 'drive-file-1',
      name: 'devices.csv',
      mimeType: 'text/csv',
      sizeBytes: 12,
      lastEditedUtc: 1,
    });
    // A second open reuses the loaded module and adds no second script.
    await picker.open('example-token', 'example-key', '123456789012');
    expect(script).toHaveBeenCalledTimes(1);
  });

  it('answers null when the person cancels', async () => {
    vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      queueMicrotask(() =>
        (node as HTMLScriptElement).onload?.(new Event('load')),
      );
      return node;
    });
    stubPicker({ action: 'cancel' });
    const picker = new GoogleDrivePicker();
    await expect(
      picker.open('example-token', 'example-key', '123456789012'),
    ).resolves.toBeNull();
  });

  it('rejects when the script cannot load, and retries the load on the next open', async () => {
    const script = vi
      .spyOn(document.head, 'appendChild')
      .mockImplementation((node: Node) => {
        queueMicrotask(() =>
          (node as HTMLScriptElement).onerror?.(new Event('error')),
        );
        return node;
      });
    const picker = new GoogleDrivePicker();
    await expect(
      picker.open('example-token', 'example-key', '123456789012'),
    ).rejects.toThrow('picker-script');
    await expect(
      picker.open('example-token', 'example-key', '123456789012'),
    ).rejects.toThrow('picker-script');
    expect(script).toHaveBeenCalledTimes(2);
  });
});
