/*
 * The Google Picker double of the browser suite
 * (`docs/superpowers/specs/2026-10-30-device-drive-slice-design.md`, C2 and DQ1).
 *
 * Playwright answers `https://apis.google.com/js/api.js` with this file. No production source
 * imports it. It implements the Picker calls that the dialog makes and records the token, the API
 * key, and the App ID of each open, so a test can prove that the session token reaches the Picker.
 *
 * It draws a neutral sample of the frame of Google. The real frame, its words, and its behavior
 * belong to Google.
 */
(() => {
  if (window.__googlePicker) return;

  /** The five files of the approved walkthrough, owned by "me" (state 06). */
  const DEFAULT_FILES = [
    {
      id: 'drive-sheet-exp-003',
      name: 'devices-for-editing-EXP-003',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      sizeBytes: null,
      lastEditedUtc: Date.UTC(2026, 9, 30, 15, 2),
      when: '11:02 AM',
    },
    {
      id: 'drive-csv-exp-001',
      name: 'devices-for-editing-EXP-001.csv',
      mimeType: 'text/csv',
      sizeBytes: 7987,
      lastEditedUtc: Date.UTC(2026, 9, 29, 20, 12),
      when: 'Oct 29',
    },
    {
      id: 'drive-sheet-library-reset',
      name: 'library-reset',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      sizeBytes: null,
      lastEditedUtc: Date.UTC(2026, 9, 26, 18, 0),
      when: 'Oct 26',
    },
    {
      id: 'drive-csv-loaner-carts',
      name: 'loaner-carts.csv',
      mimeType: 'text/csv',
      sizeBytes: 2048,
      lastEditedUtc: Date.UTC(2026, 9, 21, 16, 0),
      when: 'Oct 21',
    },
    {
      id: 'drive-sheet-room-12',
      name: 'Room 12 inventory',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      sizeBytes: null,
      lastEditedUtc: Date.UTC(2026, 9, 14, 15, 0),
      when: 'Oct 14',
    },
  ];

  const STYLE = `
    .gp-scrim { position: fixed; inset: 0; z-index: 2100; background: rgb(32 33 36 / 50%); }
    .gp-frame { position: fixed; z-index: 2101; inset: 50% auto auto 50%; transform: translate(-50%, -50%);
      display: flex; flex-direction: column; width: 1051px; height: 650px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px); border-radius: 12px; background: #fff; color: #202124;
      box-shadow: 0 24px 48px rgb(0 0 0 / 30%); font: 14px/20px Roboto, Arial, sans-serif; }
    .gp-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; }
    .gp-head h2 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 400; }
    .gp-close { border: 0; background: none; width: 40px; height: 40px; font-size: 22px; cursor: pointer; }
    .gp-search { margin: 0 24px 16px; display: flex; align-items: center; gap: 12px; height: 48px;
      padding: 0 16px; border-radius: 24px; background: #f1f3f4; color: #5f6368; }
    .gp-root { padding: 0 24px; font-weight: 500; }
    .gp-table { width: calc(100% - 48px); margin: 8px 24px; border-collapse: collapse; }
    .gp-table th { text-align: left; font-weight: 500; color: #5f6368; padding: 8px 12px; }
    .gp-table th:nth-child(2), .gp-table th:nth-child(3) { width: 180px; }
    .gp-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px 140px; align-items: center;
      width: 100%; padding: 10px 12px; border: 0; border-top: 1px solid #e8eaed; background: #fff;
      color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .gp-row:hover { background: #f8f9fa; }
    .gp-row[aria-selected="true"] { background: #e8f0fe; }
    .gp-row .gp-name { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .gp-row .gp-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gp-glyph { width: 18px; height: 18px; border: 1px solid #5f6368; border-radius: 2px; }
    .gp-glyph.sheet { border: 0; background: #188038; }
    .gp-glyph.csv { border: 0; background: #1a73e8; }
    .gp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; padding: 16px 24px; }
    .gp-actions button { height: 40px; padding: 0 24px; border-radius: 20px; font: inherit; cursor: pointer; }
    .gp-cancel { border: 1px solid #dadce0; background: #fff; color: #1a73e8; }
    .gp-select { border: 1px solid #1a73e8; background: #1a73e8; color: #fff; }
    .gp-select:disabled { border-color: #dadce0; background: #dadce0; color: #80868b; cursor: default; }
  `;

  const state = {
    calls: [],
    files: Array.isArray(window.__pickerFiles)
      ? window.__pickerFiles
      : DEFAULT_FILES,
    openCount: 0,
    lastAction: null,
    /** The chosen file of the open Picker, if any. */
    selection: null,
  };
  window.__googlePicker = state;

  let root = null;
  let callback = null;

  function close() {
    if (!root) return;
    root.remove();
    window.removeEventListener('keydown', onKeydown);
    root = null;
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  function pick(file) {
    state.lastAction = 'picked';
    close();
    callback?.({ action: 'picked', docs: [file] });
  }

  function cancel() {
    state.lastAction = 'cancel';
    close();
    callback?.({ action: 'cancel' });
  }

  function render() {
    close();
    root = document.createElement('div');
    root.className = 'gp-root-layer';

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.append(style);

    const scrim = document.createElement('div');
    scrim.className = 'gp-scrim';
    scrim.setAttribute('aria-hidden', 'true');
    root.append(scrim);

    const frame = document.createElement('section');
    frame.className = 'gp-frame';
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-modal', 'true');
    frame.setAttribute('aria-labelledby', 'gp-double-title');

    const head = document.createElement('header');
    head.className = 'gp-head';
    const title = document.createElement('h2');
    title.id = 'gp-double-title';
    title.textContent = 'Select a file';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'gp-close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', cancel);
    head.append(title, closeButton);

    const search = document.createElement('div');
    search.className = 'gp-search';
    search.textContent = 'Search in Drive';

    const label = document.createElement('p');
    label.className = 'gp-root';
    label.textContent = 'My Drive';

    const table = document.createElement('div');
    table.setAttribute('role', 'listbox');
    table.setAttribute('aria-label', 'Files in My Drive');

    const rows = state.files.map((file) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gp-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.dataset.fileId = file.id;

      const name = document.createElement('span');
      name.className = 'gp-name';
      const glyph = document.createElement('span');
      glyph.className = `gp-glyph ${
        file.mimeType === 'application/vnd.google-apps.spreadsheet'
          ? 'sheet'
          : 'csv'
      }`;
      glyph.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = file.name;
      name.append(glyph, text);

      const owner = document.createElement('span');
      owner.textContent = 'me';
      const when = document.createElement('span');
      when.textContent = file.when ?? '';

      row.append(name, owner, when);
      row.addEventListener('click', () => {
        state.selection = file;
        for (const option of table.querySelectorAll('.gp-row'))
          option.setAttribute('aria-selected', String(option === row));
        selectButton.disabled = false;
      });
      row.addEventListener('dblclick', () => pick(file));
      return row;
    });
    table.append(...rows);

    const actions = document.createElement('div');
    actions.className = 'gp-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'gp-cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', cancel);
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'gp-select';
    selectButton.textContent = 'Select';
    selectButton.disabled = true;
    selectButton.addEventListener('click', () => {
      if (state.selection) pick(state.selection);
    });
    actions.append(cancelButton, selectButton);

    frame.append(head, search, label, table, actions);
    root.append(frame);
    document.body.append(root);
    window.addEventListener('keydown', onKeydown);
    state.selection = null;
  }

  function DocsView(viewId) {
    this.viewId = viewId;
    this.includeFolders = true;
    this.selectFolder = true;
    this.mimeTypes = '';
  }
  DocsView.prototype.setIncludeFolders = function (value) {
    this.includeFolders = value;
    return this;
  };
  DocsView.prototype.setSelectFolderEnabled = function (value) {
    this.selectFolder = value;
    return this;
  };
  DocsView.prototype.setMimeTypes = function (value) {
    this.mimeTypes = value;
    return this;
  };

  function PickerBuilder() {
    this.config = {
      appId: '',
      token: '',
      apiKey: '',
      origin: '',
      views: [],
      callback: null,
    };
  }
  PickerBuilder.prototype.setAppId = function (value) {
    this.config.appId = value;
    return this;
  };
  PickerBuilder.prototype.setOAuthToken = function (value) {
    this.config.token = value;
    return this;
  };
  PickerBuilder.prototype.setDeveloperKey = function (value) {
    this.config.apiKey = value;
    return this;
  };
  PickerBuilder.prototype.setOrigin = function (value) {
    this.config.origin = value;
    return this;
  };
  PickerBuilder.prototype.addView = function (view) {
    this.config.views.push(view);
    return this;
  };
  PickerBuilder.prototype.setCallback = function (value) {
    this.config.callback = value;
    return this;
  };
  PickerBuilder.prototype.build = function () {
    const config = this.config;
    let visible = false;
    return {
      setVisible: (next) => {
        if (next === visible) return;
        visible = next;
        if (!next) {
          close();
          return;
        }
        state.openCount += 1;
        state.calls.push({
          token: config.token,
          apiKey: config.apiKey,
          appId: config.appId,
          origin: config.origin,
          mimeTypes: config.views.map((view) => view.mimeTypes),
        });
        callback = config.callback;
        render();
      },
    };
  };

  window.gapi = {
    load(module, options) {
      if (module !== 'picker') {
        options.onerror?.();
        return;
      }
      // The real loader fetches the Picker module; the double answers at once.
      setTimeout(() => options.callback(), 0);
    },
  };

  window.google = window.google || {};
  window.google.picker = {
    ViewId: { DOCS: 'docs' },
    Action: { PICKED: 'picked', CANCEL: 'cancel' },
    DocsView,
    PickerBuilder,
  };
})();
