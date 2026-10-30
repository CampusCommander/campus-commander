# Technical design addendum: device export and import, Google Drive slice

Status: proposed. Card `t_a3eea4be`. Record: `docs/workflows/batch-update-export-import.md`. The Drive slice stays proposed there (`record:13`).
Technical design: `docs/research/batch-update-export-import-technical-design.md`. Its sections 6.5, 9.3, 15, 16, 18, and 20 set the behavior. This addendum maps that behavior to code.
Mockup: `docs/ui/designs/2026-10-30-device-drive-slice.html`, its notes, and its state PNGs, stored by commit `733ce9f` (PR #186). Extends the [CSV slice addendum](2026-10-28-device-export-import-design.md), which PRs #158 to #185 built.
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Owner direction and rulings

On 2026-10-30 the owner approved version 1 of the Google Drive slice mockup. Owner, in the main chat: "approve, all recommended".
The same day he directed: "keep at it. Lets get this import export work past the goal line."
On 2026-10-30, while this card ran, the owner wrote: "I want to make sure you have the REAL drive picker and backend auth support besides the mocked one." The section "Production path and test doubles" answers it.
On 2026-10-24 he started the workflow: "We need to start the work on the CSV/Google Drive import export. For google drive we will use the google drive picker." (`record:137`). The same message adds `drive.file` to the DWD install scopes (`record:139`).
D4: "The signed in persons drive. I have confirmed You came make an oauth token from DWD and pass it to the picker in the client. Ive done this before." (`record:175`).
On 2026-09-03: "Export creates a CSV or Google Sheet." (`record:123`). On version 3 of the CSV mockup: "I dont like having the export and import preview. Just the raw data in the dialog." (`record:287`). The Drive slice draws no preview.

The screens of that mockup outrank text on composition. A live Sheet export creates a Google file, and live device writes need an enrolled test device. Both need his explicit authorization (`record:403-404`). Build tests use admin-sdk-mock and test doubles.

The card binds the recommended option of each question in `notes:296-319`. The stored notes record the same six rulings (`notes:13-21`):

1. Reports offers a CSV file only. It hides the Google Sheet card until the report Sheet ships in the third slice.
2. The import step checks the header row of a chosen Drive file before Start validation. The browser reads the row with the one-hour Drive token.
3. The Picker lists My Drive only: the Google Sheets and CSV files of the person.
4. A Sheet export lands at the top level of My Drive.
5. The Google connection page shows the saved Picker API key in full.
6. Every person reads the fix in the Drive notes, as the built device notes do.

Composition choices 1 to 15 (`notes:212-289`) are the build defaults. The notes hand the field limits and two source conflicts to engineering (`notes:323-341`). Sections 3, 5, and 7 settle them.

## Conventions

- Paths are relative to the repository root at `c734ada`. `ac/` is `libs/application-contracts/src/lib/`, `api/` is `api/src/app/`, `fe/` is `frontend/src/app/`, and `gc/` is `libs/google-connection/src/lib/`. Only `api/project.json` names the `api` folder itself.
- `record:N` cites the record, `td:N` the technical design, and `add:N` the CSV slice addendum. `prov:N` cites `gc/provider.ts`. `tls:N` cites `deployment/bootstrap/edge.mjs`, and `edge:N` cites `deployment/bootstrap/application-edge.mjs`.
- `cred:N` cites `docs/portfolio/phase-3-google-credentials.md`. `007`, `010`, `011`, and `017` name files in `deployment/postgres/migrations/`. Each change edits its migration in place, as the CSV slice did (`add:105`).
- `notes:N` cites `docs/ui/designs/2026-10-30-device-drive-slice-notes.md` at commit `733ce9f` of the parallel docs card. Every other source cites the base `c734ada`.
- State NN is `docs/ui/designs/2026-10-30-device-drive-slice-NN-<name>.png` at commit `733ce9f`.

## Decision summary

1. Export format `sheet` writes the edit template to a new Sheet in the person's My Drive, as the person. It offers no cancel after its Sheet write starts.
2. Import source types `drive-sheet` and `drive-csv` join `csv`. A first phase, `drive-read`, stores what it read. The built passes then run unchanged.
3. The `drive-files` capability joins the DWD scope list, the delegation link, and Diagnostics. It never changes the connection state.
4. A singleton table holds the Picker API key and the project number. Their own route reads and saves them. `connection:manage` saves, and each change writes an audit row.
5. Login asks for the `email` claim. The session keeps the verified sign-in email as the person's DWD subject.
6. `POST /api/google/drive/session` mints a one-hour `drive.file` token for that subject. A refused exchange marks Drive unavailable for the session.
7. The edge adds three content security directives: the Picker script, the Picker frame, and the browser header read. The referrer policy stays `no-referrer`.
8. Production calls the real Google endpoints. Tests replace Google with a fake transport, admin-sdk-mock 0.3.0, and a Playwright Picker double.
9. Fourteen backend cards, three frontend cards, and two qa cards build the slice. A live Sheet export step waits for the owner.

## Production path and test doubles

Production code calls the real Google endpoints. It holds no setting that points it at a double:

- Token exchange: `scopedClient` signs a JWT for one subject and one scope (`prov:310-347`). The credential schema accepts only `https://oauth2.googleapis.com/token` (`gc/credential.ts:18`).
- Drive and Sheets: new `gc/drive.ts` calls `https://www.googleapis.com/drive/v3` and `https://sheets.googleapis.com/v4`. `googleRequestAllowed` lists the only Google URLs that the application calls (`prov:229-246`).
- Picker: the dialog loads `https://apis.google.com/js/api.js`. The Picker opens its frame from `https://docs.google.com` (section 5).

The doubles serve tests only:

- The Drive fake transport follows `gc/batch-fake.mjs`, which only `*.test.mjs` files import.
- admin-sdk-mock answers the real hostnames. Its proxy and CA route a test process to it (`gc/capability-health-mock.test.mjs:25-26`).
- Review containers reach the mock through network aliases of those hostnames (`api-e2e/admin-sdk-mock-fixture.mjs:17-23`). The same images run there with the trust bundle of the mock in `NODE_EXTRA_CA_CERTS` (`api-e2e/auth.test.mjs:766`).
- The Picker double lives under `frontend-e2e/`. Playwright routes the Picker script to it.
- DB5, DF2, and DM2 each check that no production source imports their double. DQ2 runs the real path on the owner's domain.

## 1. Contracts

| Place                                                      | Change                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_EXPORT_FORMATS`, `ac/device-export.ts:24-27`       | Adds `sheet` (`td:366`, `add:402`).                                                                                        |
| `deviceExportRequestSchema`, `ac/device-export.ts:132-157` | A `sheet` export needs purpose `edit`. Reports stays a CSV file (ruling 1, `td:100`).                                      |
| `deviceExportFileName`, `ac/device-export.ts:174-180`      | A Sheet takes the CSV name without `.csv` (`notes:227`).                                                                   |
| `JOB_PHASES`, `ac/jobs.ts:131-138`                         | Adds `create-sheet` after `write-rows`, and `drive-read` before `header-check` (choices 2 and 10).                         |
| `jobFailureSchema`, `ac/jobs.ts:117-126`                   | Adds `drive-unavailable` and `sheet-write-failed` for a Sheet export (section 6).                                          |
| `exportFile`, `ac/jobs.ts:409-417`                         | Adds `format` and `sheetUrl`. `sizeBytes` and `expiresAt` turn null for a Sheet, which never expires (`notes:225`).        |
| `importSource`, `ac/jobs.ts:420-436`                       | Adds `sourceType` and `tabTitle` for states 10 and 13.                                                                     |
| `DEVICE_IMPORT_REFUSALS`, `ac/device-import.ts:58-66`      | Adds `drive-source-unavailable` (`td:594`), `source-too-large`, and `rows-too-large` (`td:577`).                           |
| `deviceImportRefusalText`, `ac/device-import.ts:75-101`    | Takes the source name for the state 13 sentence (`notes:585`). Each limit refusal names its limit (`td:577`).              |
| New `ac/google-drive.ts`                                   | Source types, the Drive import request and receipt, the access answer, the session answer, the tab list, and the settings. |

- The new `exportFile` and `importSource` keys default to the CSV values. Built fixtures then parse unchanged. The API sends every key.
- `GET /api/google-connection` keeps its strict answer (`ac/google-connection.ts:102-104`). Seventeen `frontend-e2e` files answer that route. The Drive settings take their own route.

The source type `csv` stays the uploaded file (`017:367`). `drive-sheet` names a Sheet tab, and `drive-csv` a CSV file in Drive (`td:557`).
A Drive source carries `fileId`: 1 to 128 letters, digits, hyphens, or underscores. A Sheet adds `tabId`, the integer sheet ID of the Sheets API.
The export link is `exportFile.sheetUrl`. The API builds it from the stored spreadsheet ID (section 6). Route names are engineering defaults (`td:907`).

| Route                                       | Request                                       | Answer                                                                                      | Refusals                                                                                                           |
| ------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /api/devices/exports`                 | Adds `format: 'sheet'` with `purpose: 'edit'` | The built receipt (`ac/device-export.ts:161-167`)                                           | 409 `drive-unavailable` with `cause`                                                                               |
| `GET /api/google/drive`                     | Nothing                                       | `{ sheetExport, driveImport }`, each `{ available: true }` or `{ available: false, cause }` | None                                                                                                               |
| `POST /api/google/drive/session`            | An empty object                               | `{ accessToken, expiresAt, apiKey, appId }` (`td:920`)                                      | 409 `drive-unavailable` with `cause`, 503 `google-unavailable`                                                     |
| `GET /api/google/drive/files/{fileId}/tabs` | The Drive file ID                             | `{ fileId, tabs: [{ tabId, title, index }] }` (`td:921`)                                    | 404 `drive-file-unavailable`, 409 `drive-unavailable`, 422 `not-a-sheet`                                           |
| `POST /api/devices/imports/drive`           | `{ mode, fileId, tabId }` (`td:914`)          | `{ jobId, displayId, status, mode, name, sourceType, tabTitle }`                            | 404 `drive-file-unavailable`, 409 `drive-unavailable`, 422 `wrong-file-type`, `tab-missing`, or `source-too-large` |
| `GET /api/google-connection/drive`          | Nothing                                       | `{ drive }`: the saved settings, or null                                                    | 403                                                                                                                |
| `POST /api/google-connection/drive`         | `{ pickerApiKey, projectNumber }`             | `{ drive }`                                                                                 | 403, 422 with the field                                                                                            |

- `cause` is `setup`, `delegation`, or `account`, the three causes of choice 4 (`notes:228-234`). `setup` never applies to `sheetExport`, because an export opens no Picker.
- The access read takes the cause from stored facts only: the settings row, the last `drive-files` result, and the session. It calls no Google API.
- Errors keep the reason style of `td:923`. The person never names a subject, a credential, or a customer ID (`td:924`).
- The access read needs `devices:read`. The session route, the tab list, and the Drive import need the import permissions (`record:107`).
- A Sheet export needs the export permissions (`record:106`). The settings read takes the permission of `GET /api/google-connection` (`api/auth/google-connection.controller.ts:33-36`).
- The settings save needs `connection:manage` at platform scope, as `api/auth/google-connection.controller.ts:117-122` does.
- A tab list holds 1 to 1,000 tabs, and a title holds 1 to 255 characters. Google sets the real limits (`notes:329`).

## 2. Google access

- `GOOGLE_CAPABILITIES` (`ac/google-capabilities.ts:2-82`) adds `drive-files` with the values of `td:949-956`. Its label is "Google Drive files", and its method is `files.list`.
- The entry sets `requiredForConnection: false`, `enabled: true`, and `qualified: false` until the checks of `td:1003-1008` pass.
- `GOOGLE_SETUP_CAPABILITY_IDS` (`ac/google-capabilities.ts:85-92`) lists it last. `GOOGLE_SETUP_SCOPES` (`ac/google-capabilities.ts:98-106`) then holds seven scopes (`td:958`).
- The delegation link takes its known scopes from the capability list (`ac/google-delegation-link.ts:10-12`). It sorts the requested and verified scopes together (`ac/google-delegation-link.ts:18-23`), so it keeps every verified scope (`td:959`).
- The health check adds a `drive-files` case beside `device-changes` (`prov:501`). It calls `files.list` with page size 1 as the delegated administrator (`td:954`, `td:960`).
- `googleRequestAllowed` (`prov:230-245`) admits `https://www.googleapis.com/drive/v3/files` for that call.
- SQL: the capability check (`010:34`) and `cc.google_health_capabilities_valid` (`010:7-10`) accept seven names. `cc.google_health_state` adds `('drive-files',false)` at `011:308`.
- Connection state: the capability is optional, so a failed Drive check leaves `connectionState` active (`ac/google-health.ts:54`). Device features keep their own checks.
- The shell counts the seven setup capabilities (`fe/google-connection/health.store.ts:138-147`). State 14 shows "Google: 1 of 7 capabilities need attention" (`notes:462`).
- Diagnostics shows the seventh check from the capability list (`fe/diagnostics/diagnostics.html:183-186`, choice 14). Its step 1 takes the drafted text of `notes:614`.
- The access read answers cause `delegation` while the last `drive-files` result holds `delegation-not-authorized` or `scope-mismatch` (`ac/google-health.ts:102-106`, `ac/google-health.ts:122-126`).

## 3. The setup inputs

- Place: a singleton table `cc.google_drive_settings` at the end of `007`, beside the connection (`007:96-107`). It holds `picker_api_key`, `project_number`, `saved_by`, and `saved_at`.
- `td:970` puts both inputs on the Google connection page. Choice 13 draws the card (`notes:276-281`).
- Save: `cc.save_google_drive_settings` checks `connection:manage` through `cc.google_connection_actor` (`007:109`). The API route checks the same action at platform scope.
- Read: `GET /api/google-connection/drive` answers the readers of the connection page. The page shows the key in full (ruling 5).
- The session route sends the key and the project number to an import person (`td:920`, `td:985`). The project number serves as the Picker App ID (`td:968`).
- Field rules (`notes:327-328`): the key holds exactly 39 letters, digits, hyphens, or underscores. The project number holds 1 to 20 digits and no leading zero.
- The contract and the table checks apply both rules. The state 15 sample key passes them (`notes:145`).
- Stored value: the key is not a secret. Every browser that opens the Picker receives it (`td:985`, `notes:314`). The table holds it as plain text, outside the credential envelope (`007:13-23`).
- Restriction: the key carries an API restriction to the Picker API only (`td:967`, `td:992`, `td:1345`).
- Audit: a save that changes a value writes one `drive-settings-changed` event. It holds the actor, the correlation ID, the project number, and whether the key changed.
- The event joins the event check at `017:1552-1562`, its last definition. A save without a change writes no event.
- A credential replacement keeps the settings, because the connection keeps its customer.

## 4. The token path

- Login asks for `openid profile` today (`api/auth/auth.service.ts:127`). It adds `email`, because `td:977` needs the verified sign-in email.
- The callback reads the claims (`api/auth/auth.service.ts:170-171`). It keeps `email` only when `email_verified` is true.
- `sessionSchema` (`api/auth/session-entry.ts:3-8`) adds `driveSubject`: that email, or null. The session cache holds it for the session lifetime. No table holds it.
- The subject comes from the server session, never from a request (`td:979`).
- Without saved settings the session route answers cause `setup` before any exchange.
- Exchange: the API calls `scopedClient` (`prov:310-347`) with the stored credential, the person's subject, and the single scope `drive.file` (`td:977`).
- `scopedClient` already refuses a token with another scope or a lifetime above 3,605 seconds (`prov:328-335`). Google issues one hour (`td:986`).
- The answer carries the token, its expiry, the key, and the App ID. It sends `cache-control: no-store` (`td:986`).
- Campus Commander stores no copy of the token (`td:986`). No cache entry, log line, audit detail, or table row holds it.
- A refusal of `delegation-not-authorized` (`prov:116-121`) or `scope-mismatch` gives cause `delegation`, state 04.
- A refusal of `credential-rejected` gives cause `account`, state 12. That code covers the `invalid_grant` refusal of a subject (`prov:122-128`).
- The session stores the cause. Later access reads answer unavailable without a new exchange until the next sign-in (`td:980`).
- A network fault, a quota answer, or an unavailable Google answers 503 and marks nothing.
- The CSV path stays available in every case (`td:980`, `td:1042`). A person outside the domain uses CSV files (`td:981`).
- The browser asks for a new session when its token expires within 5 minutes. A Picker open or a header read then waits for it.
- Jobs: a Sheet export and a Drive import store the subject on their detail row at submission. The worker mints its own token for that subject (`td:996`).

## 5. The Picker in the browser and the edge

- The dialog loads `https://apis.google.com/js/api.js` and builds the Picker with the token, the key, and the App ID (`td:985`, `td:1479-1481`).
- The view lists the Google Sheets and CSV files that the person owns. It hides folders and allows one file (ruling 3, `td:987`).
- The browser sends only the chosen file ID to the API (`td:988`).
- The edge sends `default-src 'self'` and no `script-src`, `frame-src`, or `connect-src` today (`tls:114`). `td:989-990` lets the edge allow the exact Picker origins only.

| Directive     | Value                                                             | Source                                 |
| ------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `script-src`  | `'self' https://apis.google.com`                                  | The Picker loader, `td:990`, `td:1479` |
| `frame-src`   | `https://docs.google.com`                                         | The Picker frame, `td:990`             |
| `connect-src` | `'self' https://sheets.googleapis.com https://www.googleapis.com` | The browser header read of ruling 2    |

- Every other directive keeps its value, `frame-ancestors 'none'` included. One constant in `tls` holds the Google origins.
- The mockup leaves these origins unverified (`notes:349`). DQ2 records them on the owner's domain (`record:435-436`). A missing origin then joins the constant under `td:990`.
- Referrer: the edge keeps `referrer-policy: no-referrer` (`tls:110`). The key carries an API restriction only (`td:991-992`, engineering default `td:1345`).
- Risk 5 of the record names a referrer change (`record:412`). The technical design settles it with that default. State 14 step 3 states it (`notes:601`, `notes:340`).
- If DQ2 shows a Picker refusal without a referrer, that change goes to the owner as a question.
- Paths: `connectionRead` (`edge:56-57`) and `connectionWrite` (`edge:58-59`) add `drive` (`td:970`). `deviceImportWrite` (`edge:91-93`) adds `/api/devices/imports/drive` (`td:914`).
- New patterns admit the three paths of `td:920-921`.
- Header read (ruling 2): the browser reads through Google, not through the API. It sends the bearer token and no cookie.
- A Sheet reads rows 1 and 2 of the chosen tab with `spreadsheets.values.get` and formatted values.
- A CSV file reads `files.get` with `alt=media` and `Range: bytes=0-65535`, the 64 KiB of the built check (`fe/devices/device-import-messages.ts:36-37`).
- The built check then runs on the cells: a header row and one data row (`add:331`, `td:1333`).

## 6. The Sheet export job

API and SQL:

- `POST /api/devices/exports` accepts `format: 'sheet'` for an edit export (ruling 1). It runs the exchange of section 4 and keeps no token. A refusal answers 409 with its cause.
- `cc.create_device_export_job` (`017:909-919`) accepts `sheet` and the subject. `cc.device_export_jobs` (`017:319-348`) adds `drive_subject`, `sheet_started_at`, and `spreadsheet_id`.
- The phase checks of `cc.jobs` (`017:46`, `017:69`) add `create-sheet` for an export and `drive-read` for a validation.
- The file check (`017:345-347`) splits by format. A CSV file keeps the artifact facts. A Sheet holds the spreadsheet ID, the rows, and the columns, and no size or expiry.
- `cc.renew_device_export_job` accepts phase `create-sheet` (`017:1150`).
- `cc.finish_device_export_job` takes a Sheet file without an artifact, a size, or an expiry (`017:1331-1342`). A Sheet ends in phase `create-sheet`, not `prepare-download` (`017:1381-1382`).
- `drive-unavailable` and `sheet-write-failed` join the failure check (`017:49-52`) and `cc.job_failure_known` (`017:1986-1991`). The finish then settles both.
- `cc.claim_device_export_job` (`017:1048-1082`) ends a Sheet export with `sheet_started_at` Failed `interrupted` and answers `done`. A retried dispatch then creates no second Sheet.

Worker, in `worker/src/device-export.ts`:

1. Phase `write-rows` stages the template rows in the artifact store, as built (`worker/src/device-export.ts:669`). A Sheet row skips the formula tab, because `RAW` stores text (`td:367`).
2. The checksum covers the unescaped values already (`td:361`), so a Sheet row keeps the checksum of a CSV row.
3. `cc.start_device_export_sheet` locks the header, then the detail row. A stored cancel request ends the run Cancelled. Otherwise it stamps `sheet_started_at` and phase `create-sheet`.
4. As the person, `spreadsheets.create` makes one Sheet with the tab Devices (`notes:227`). It lands at the top level of My Drive (ruling 4). The create body freezes the header row (`td:369`).
5. `spreadsheets.batchUpdate` with one `repeatCell` request sets the text number format on columns A to J (`td:368`).
6. `spreadsheets.values.update` with `RAW` writes the header, then 1,000 rows per call in row order (`td:367`, `td:999`).
7. The finish records the spreadsheet ID, the name, the rows, and the columns (`td:352`, `td:370`). The worker then removes the staged rows.

- Phases: "Write rows", then "Create Google Sheet" (choice 2, `notes:217-221`). `create-sheet` counts nothing and draws no bar.
- Cancel: record engineering default 15 bars a cancel after the Sheet write starts (`record:336`, `td:855`).
- `cc.request_job_cancel` refuses an EXP job with `sheet_started_at` as `nothing-to-stop` (`017:776-782`, `017:790`). Both take the header lock before the detail row (`add:162`, `add:165`), so one of them wins.
- Link: the API builds `https://docs.google.com/spreadsheets/d/{id}/edit` from the stored ID. It keeps no URL that Google sent.
- Retries: a 429 or 5xx answer to `values.update` repeats the same range with backoff, at most 5 tries. `spreadsheets.create` never repeats, because a lost answer leaves a second Sheet.
- Failure: a refused token fails the job `drive-unavailable`. A failed Sheets call fails it `sheet-write-failed`.
- The partial Sheet stays in My Drive, and the job records no link (`td:351`, `td:1041`). A lost run fails `interrupted` through the built recovery (`add:196`, `017:1498-1500`).
- The person owns the Sheet (`td:932`). The 50,000-device limit and its 422 stay (`td:171`, `add:192`).

## 7. The Drive import

API, `POST /api/devices/imports/drive`:

- It checks the import and status permissions as the upload route does (`add:83`), then Drive availability.
- It reads `files.get` metadata as the person. A Google Sheet needs a tab that `spreadsheets.get` lists (`td:588`). A CSV file needs no tab and at most 1 GiB (`edge:97`).
- Another file type answers 422 `wrong-file-type`. The job takes the file name from Drive, not from the browser.
- The request carries either import mode, so both modes read a Drive source (`record:54-56`).
- `cc.device_import_jobs` (`017:363-370`) adds the file ID, the tab ID and title, and the subject. Its type check (`017:367`) adds the two Drive types.
- `cc.create_device_import_job` (`017:981-992`) accepts the two Drive types, the file ID, the tab ID and title, and the subject. It links no artifact.

Worker, phase `drive-read` before `header-check` (`worker/src/device-import.ts:936`):

1. The claim answers the Drive fields when no artifact holds the source (`017:1128-1136`). The built null-artifact failure applies to `csv` only (`worker/src/device-import.ts:919-924`).
2. Sheet: `spreadsheets.get` finds the tab by its ID and reads its current title. `spreadsheets.values.get` reads formatted values in windows of 1,000 rows across the full width (`td:589`).
3. Each window pads its rows to the header width. A value right of the header refuses as `ragged-record`, as in a CSV file (`td:574`).
4. The `ac/csv.ts` writer appends each row to a streamed stage (`add:400`). Hidden and filtered rows count, because `values.get` returns them (`td:591`).
5. CSV: `files.get` with `alt=media` streams the bytes into the stage (`td:592`). The `ac/csv.ts` reader counts the records on the way.
6. The phase counts the data rows read (choice 10, `notes:261-262`). `cc.renew_device_import_job` accepts `drive-read` under its 50,000 bound (`017:1185-1187`).
7. The worker publishes the stage as the job's source artifact, kept 30 days (`td:933`, `worker/src/device-import.ts:116`).
   `cc.store_device_import_source` links it under the lease and records its size. The two built passes then run unchanged (`add:400`).
8. Later Drive edits change nothing (`td:593`). Revalidate (`add:72`) reuses the stored artifact and reads no Drive file.

Limits of the CSV slice:

- 50,000 data rows, 16,384 characters per cell (`ac/csv.ts:19`), and 1 GiB of stored text (`edge:97`). The built passes apply the row and cell limits.
- `drive-read` refuses as `too-many-rows` at data row 50,001 (`ac/device-import.ts:64`), and as `source-too-large` past 1 GiB.
- A window answer holds at most 64 MiB, a limit of its own. A larger answer refuses as `rows-too-large`.
- A template row at the field limits holds 5,880 UTF-16 units (`ac/devices.ts:437-445`, `add:179`). JSON writes a unit as at most 6 characters, so 1,000 such rows take about 35 MB.

Source errors (`td:594`, `td:1047`):

- A Drive 404 or 403, a missing tab, or a refused token refuse as `drive-source-unavailable`. The text names the file (state 13, `notes:585`).
- No other file or tab replaces the source. Import again returns to state 05 (choice 11).
- A 429, a 5xx, or a network fault repeats with backoff, at most 5 tries. The job then fails with the built Google failure code (`ac/devices.ts:343-346`).

## 8. The client

| State | Reads                                                                         | Sends                                                        |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 01    | `GET /api/google/drive` and the selected count                                | `POST /api/devices/exports` with `format: 'sheet'`           |
| 02    | The job detail (`phase`) and the job events                                   | Nothing. Close only (choice 2)                               |
| 03    | The job detail `exportFile`: name, rows, columns, and `sheetUrl`              | A new tab on `sheetUrl` with `noopener noreferrer`           |
| 04    | `GET /api/google/drive`, cause `delegation`                                   | Nothing. CSV file stays selected                             |
| 05    | `GET /api/google/drive`, `driveImport` available                              | Nothing                                                      |
| 06    | `POST /api/google/drive/session`: token, key, and App ID                      | The Picker script and frame of Google                        |
| 07    | The Picker document, `GET …/files/{fileId}/tabs`, and rows 1 and 2 of the tab | Nothing                                                      |
| 08    | The Picker document: name, size, and edit time. The first 64 KiB of the file  | Nothing                                                      |
| 09    | The help topics                                                               | Nothing                                                      |
| 10    | The receipt, the job detail (`phase`, `importSource`), and the job events     | `POST /api/devices/imports/drive`. Stop validation cancels   |
| 11    | `GET /api/google/drive`, cause `setup`                                        | Nothing. Upload a CSV file stays selected                    |
| 12    | A 409 `drive-unavailable` with cause `account` from the session route         | Nothing. The dialog selects Upload a CSV file                |
| 13    | The job detail: refusal `drive-source-unavailable` and its text               | Import again returns to state 05                             |
| 14    | `GET /api/google-connection/drive` with `drive: null`, and the health result  | `POST /api/google-connection/drive`, the `drive-files` check |
| 15    | The same reads with the saved settings                                        | The same                                                     |
| 16    | `GET /api/google-connection/health`                                           | Recheck sends the `drive-files` check                        |

- Ruling 1: the Reports dialog hides the Google Sheet card. Ruling 3: the view lists owned Sheets and CSV files only.
- Ruling 6: each cause note shows to every person, whatever the person's connection permissions.
- The Picker document supplies the name, the type, the size, and the edit time for display only. The API reads its own facts (section 7).
- A Sheet whose tab list or header read fails shows a drafted alert. Start validation stays disabled.

Built behavior that changes:

1. The Format group (`fe/devices/device-export-import-dialog.html:76-92`) enables Google Sheet by the access read. Reports hides the card.
2. The Source group (`fe/devices/device-export-import-dialog.html:199-216`) enables Google Drive by the access read.
3. `DRIVE_SOURCE_NOTE` (`fe/devices/device-export-import-dialog.ts:377-378`) splits into the three cause notes of choice 4. `SHEET_FORMAT_NOTE` (`fe/devices/device-export-messages.ts:41-42`) stays the `account` note.
4. `EXPORT_PHASES` (`fe/devices/device-export-import-dialog.ts:893-894`) ends with `create-sheet` for a Sheet. `IMPORT_PHASES` (`fe/devices/device-import-messages.ts:143-149`) starts with `drive-read` for a Drive source.
5. `IMPORT_PHASE_LABELS` (`fe/jobs/job-fields.ts:258-262`) and the export lines (`fe/jobs/job-fields.ts:374`, `fe/jobs/job-fields.ts:391-393`) add the two phases.
6. `cancelState` (`fe/jobs/job-detail-fields.ts:417-421`) offers no Cancel pending work in phase `create-sheet`.
7. The ready file card shows the Sheet variant of choice 3. The `jobSub` items take the ellipsis and the tooltip of choice 12 (`notes:334`).
8. The help gains the Google Drive topic of choice 9.
9. The Google connection page adds the Drive card after `<app-credential-management />` (`fe/google-connection/google-connection.html:54`, choice 13).
10. Diagnostics changes its step 1 (`fe/diagnostics/diagnostics.html:257`) to the text of `notes:614`.

## 9. Tests

| ID  | Target and file                                                                                                                            | Check                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | `application-contracts:test`: `ac/device-export.test.mjs`, `ac/device-import.test.mjs`, `ac/jobs.test.mjs`, new `ac/google-drive.test.mjs` | `sheet` needs `edit`. Each new block and route schema parses. A built fixture takes the CSV defaults. A 38-character key refuses.                                             |
| K2  | Same target: `ac/google-setup-scopes.test.mjs`, `ac/google-health.test.mjs`, `ac/google-delegation-link.test.mjs`                          | Seven setup scopes with `drive.file` last. The link lists seven sorted scopes. Health holds seven results.                                                                    |
| S1  | `deployment:postgres-integration`: `deployment/postgres/google-health.integration.mjs`                                                     | The state holds seven results. A failed `drive-files` result leaves the connection active.                                                                                    |
| S2  | Same target: `deployment/postgres/device-export-import.integration.mjs`                                                                    | The Sheet and Drive rows pass their checks. After the stamp, a cancel answers `nothing-to-stop`.                                                                              |
| S3  | Same file, two sessions                                                                                                                    | The stamp races a cancel, and one wins. A settings change writes one event, and a repeat writes none.                                                                         |
| S4  | Same file                                                                                                                                  | Renewal takes `create-sheet` and `drive-read`. A Sheet finish and both new failures settle. A claim after the stamp ends `interrupted`. A CSV finish keeps its facts.         |
| G1  | `google-connection:test`: `gc/capability-health.test.mjs`, new `gc/drive.test.mjs` with new `gc/drive-fake.mjs`                            | The health call. One scope and the person's subject. Each refusal cause. Windows, padding, and every cap.                                                                     |
| G2  | Same target: `gc/capability-health-mock.test.mjs` against admin-sdk-mock                                                                   | On 0.2.0, six results without `drive-files`. On 0.3.0, seven pass, and a client without `drive.file` fails only `drive-files`.                                                |
| H1  | `api-e2e:phase3-auth-integration` (`api-e2e/project.json:141-147`): `api-e2e/google-health.mjs`                                            | Through the synthetic preload: seven capabilities, a passed `drive-files` check, and "Google: 7 last checks passed".                                                          |
| E1  | `deployment:bootstrap-test`: `edge.test.mjs`, `application-edge.test.mjs`                                                                  | Three new directives, the others unchanged, and `no-referrer`. Each new path passes. A bad file ID answers 404.                                                               |
| A1  | `api:test`: new `api/src/app/drive/drive.test.mjs`                                                                                         | Each cause and its session mark. `no-store`. No token in a log or the cache.                                                                                                  |
| A2  | `api:test`: `api/src/app/devices/device-exports.test.mjs`, `device-imports.test.mjs`, and `api/src/app/jobs/jobs.test.mjs`                 | The Sheet export check. Each Drive import refusal. The `exportFile` and `importSource` blocks of each source.                                                                 |
| A3  | `api:test`: new `api/src/app/auth/google-drive-settings.test.mjs`                                                                          | The settings read and save, the permission refusal, and the field refusals.                                                                                                   |
| A4  | `api:test`: new `api/src/app/auth/login-email.test.mjs`                                                                                    | Login asks `openid profile email`. The session keeps the email only with `email_verified`.                                                                                    |
| W1  | `worker:test`: `worker/src/device-export.test.mjs` with the fake transport                                                                 | `RAW`, row order, the text format, the frozen row, and the Devices tab. The stamp precedes the first Sheets call. A lost create answer fails the job without a second create. |
| W2  | `worker:test`: `worker/src/device-import.test.mjs`                                                                                         | Tab by ID, padding, the ragged refusal, hidden rows, the CSV stream, the row count, caps, and source errors. Revalidation calls no Drive method.                              |
| W3  | `worker:test`: `worker/src/device-import-mock.test.mjs` against admin-sdk-mock 0.3.0                                                       | A Sheet export, a tab read, and a Drive CSV read through the mock. One data set gives one report (`td:1183`).                                                                 |
| C1  | `frontend:test`: the dialog, store, help, Google connection, Diagnostics, and job field specs                                              | Each row of the state table. Reports hides Google Sheet. Each cause note shows. A token within 5 minutes of expiry renews first.                                              |
| C2  | `frontend-e2e:e2e`: new `frontend-e2e/src/device-drive.spec.ts`                                                                            | States 01 to 13 against a mocked API, the Picker double, and routed Google answers.                                                                                           |
| C3  | `frontend-e2e:e2e`: new `frontend-e2e/src/google-drive-settings.spec.ts`                                                                   | States 14 to 16 against a mocked API.                                                                                                                                         |
| Q1  | `api-e2e:client-review-mock` (`api-e2e/project.json:22-41`)                                                                                | Card DQ1.                                                                                                                                                                     |
| Q2  | No target: the owner's domain                                                                                                              | Card DQ2.                                                                                                                                                                     |

No test writes to live Google (`record:403-404`). `td:1010` sends tests through a fake transport.
The `api:test` command lists seven folders (`api/project.json:78`). It misses `api/src/app/drive/`, so DB8 adds that folder for A1.

| Call                                                                           | Test double today                                                                                                                                                                | Cover                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The token exchange for `drive.file`                                            | admin-sdk-mock grants exactly the harness list (`api-e2e/admin-sdk-mock-fixture.mjs:24-27`)                                                                                      | DB2 adds the scope to the capability list that feeds it          |
| The synthetic token, tokeninfo, and `files.list` of H1                         | The preload maps an unknown scope to the domain token (`api-e2e/google-connection-preload.cjs:119-152`) and throws on `files.list` (`api-e2e/google-connection-preload.cjs:353`) | DB2 adds a Drive token, its scope, and an empty file list        |
| `files.list`, `files.get` metadata, and `files.get` media                      | admin-sdk-mock 0.2.0 serves none (`td:1010`)                                                                                                                                     | The fake transport of G1, W1, and W2. DM1 serves G2, W3, and DQ1 |
| `spreadsheets.create`, `get`, `batchUpdate`, `values.get`, and `values.update` | Not served. The proxy carries four hosts, without `sheets.googleapis.com` (`docs/testing/admin-sdk-mock.md:99`)                                                                  | The same fake. DM1 serves them, and DM2 adds the host alias      |
| The Picker script and frame                                                    | No REST call                                                                                                                                                                     | The Playwright double of C2 and DQ1                              |
| The browser header read                                                        | Not served                                                                                                                                                                       | C2 routes both API origins. DQ1 routes them to the mock          |

## Risks

1. The Picker origins come from the Google documentation. DQ2 records them on the owner's domain (section 5).
2. A lost `spreadsheets.create` answer or a failed write leaves a Sheet in My Drive without a link.
3. The browser holds a `drive.file` token for up to one hour (`td:1031`, `record:412`).
4. The session cache and the Drive job rows hold the person's sign-in email.
5. admin-sdk-mock 0.3.0 models Drive and Sheets answers from the documentation. DQ2 checks the read answers on the owner's domain.
6. The live Sheet export stays unverified until DQ3. Live device writes stay unverified (`record:403-404`).

## Card plan

| ID  | Title                                                                | Profile  | Depends on                                 |
| --- | -------------------------------------------------------------------- | -------- | ------------------------------------------ |
| DB1 | Contracts: Sheet format, Drive sources, phases, routes, and settings | backend  | none                                       |
| DB2 | Google access: the `drive-files` capability                          | backend  | none                                       |
| DB3 | Schema: Drive settings and the Sheet and Drive job functions         | backend  | DB1                                        |
| DB4 | Auth: the verified sign-in email in the session                      | backend  | none                                       |
| DM1 | admin-sdk-mock 0.3.0: the Drive and Sheets subset                    | backend  | none                                       |
| DB5 | Google client: Drive and Sheets calls as the person                  | backend  | DB1, DB2                                   |
| DB6 | Edge: content security directives and the Drive paths                | backend  | DB1                                        |
| DB7 | API: Drive settings on the Google connection                         | backend  | DB3                                        |
| DB8 | API: Drive access, session, and tab list                             | backend  | DB3, DB4, DB5, DB6, DB7                    |
| DB9 | Worker: the Sheet export                                             | backend  | DB3, DB5                                   |
| DBA | Worker: the Drive read of a validation                               | backend  | DB3, DB5, DB9                              |
| DBB | API: Sheet export and Drive import submission                        | backend  | DB8, DB9, DBA                              |
| DBC | Jobs API: the Sheet file and the Drive source blocks                 | backend  | DB1, DB3                                   |
| DM2 | Pin admin-sdk-mock 0.3.0 and route Sheets in the harness             | backend  | DM1, DB2, DB9, DBA                         |
| DF1 | Devices dialog: Sheet export and the Drive access read               | frontend | DBB, DBC                                   |
| DF2 | Devices dialog: Drive import, the Picker, and the Drive help         | frontend | DF1, DBB                                   |
| DF3 | Google connection Drive card and Diagnostics                         | frontend | DB2, DB7                                   |
| DQ1 | Rehearse the Drive steps on admin-sdk-mock                           | qa       | DF1, DF2, DF3, DM2                         |
| DQ2 | Live read-only Drive check on the owner's domain                     | qa       | DQ1                                        |
| DQ3 | Live Sheet export on the owner's domain                              | qa       | DQ2 and the owner's explicit authorization |

IDs are local to this design. A card that changes a contract updates every consumer, the `frontend-e2e` and `api-e2e` fixtures included.

**DB1.** Scope: section 1 in `ac/device-export.ts`, `ac/device-import.ts`, `ac/jobs.ts`, and new `ac/google-drive.ts`, with K1. The new refusal texts take the drafted strings of DF2.
It fixes each consumer of the wider schemas. A CSV export answers `format: 'csv'`, and an upload answers `sourceType: 'csv'`. Acceptance: K1 passes. `api:test`, `worker:test`, `frontend:build`, `frontend:test`, and `frontend-e2e:e2e` pass.

**DB2.** Scope: section 2 in `ac/google-capabilities.ts`, `010`, and `011`. It adds the `drive-files` case and its allowlist entry in `prov`. It owns K2, S1, G2, H1, and the `gc/capability-health.test.mjs` rows of G1.
It updates the six-capability fixtures: `frontend-e2e/src/job-cancel.spec.ts:733-747`, `frontend-e2e/src/google-health.spec.ts:149`, `frontend-e2e/src/google-health.spec.ts:163`, `frontend-e2e/src/google-health.spec.ts:184`, `fe/google-connection/health.store.spec.ts:207`, and `fe/google-connection/health.store.spec.ts:218`.
H1 runs without the mock (`api-e2e/auth.test.mjs:769-771`, `api-e2e/auth.test.mjs:2505-2513`). DB2 extends the synthetic preload as the gap table states.
`api-e2e/google-health.mjs` then expects seven capabilities and a passed `drive-files` check (`api-e2e/google-health.mjs:48`, `api-e2e/google-health.mjs:101-103`, `api-e2e/google-health.mjs:199-215`).
G2: 0.2.0 serves no Drive method, so the test checks its capability list without `drive-files` (`gc/capability-health-mock.test.mjs:15`, `gc/capability-health-mock.test.mjs:55-90`).
Acceptance: K2, S1, G1, G2 on 0.2.0, and H1 pass. The delegation link lists seven scopes. `frontend:test` and `frontend-e2e:e2e` pass.

**DB3.** Scope: the settings table and its save function in `007`, and the event in `017:1552-1562`. It owns every `017` change of sections 6 and 7: columns, checks, phases, and failure codes.
Functions: both claims, both renewals, the export finish, `cc.job_failure_known`, the cancel refusal, `cc.start_device_export_sheet`, and `cc.store_device_import_source`.
It owns their grants (`deployment/postgres/index.mjs`), S2, S3, and S4. Acceptance: S2, S3, and S4 pass on a fresh database. The built `deployment:postgres-integration` tests pass.

**DB4.** Scope: section 4 login and session in `api/auth/auth.service.ts` and `api/auth/session-entry.ts`, with A4.
`api-e2e:client-review-mock` signs in through the inline provider of `api-e2e/auth.test.mjs`. Its scope check (`api-e2e/auth.test.mjs:459`) takes `openid profile email`.
Its ID token (`api-e2e/auth.test.mjs:525-536`) adds `email` and `email_verified: true` for the review administrator (`api-e2e/client-review-identity.mjs:4`).
That email is the delegated email of the run: `mock.adminEmail` on the mock, or `administrator@fixture.invalid` (`api-e2e/auth.test.mjs:929-931`).
`api-e2e/provider-fixture.mjs` makes the same change (`api-e2e/provider-fixture.mjs:46`, `api-e2e/provider-fixture.mjs:88-95`), with its caller (`api-e2e/provider-fixture.test.mjs:81`).
The sign-in client instructions add the `email` scope (`deployment/bootstrap/APPLICATION-ACCESS.md:32`, `deployment/installer/PHASE-2.md:9`).
Acceptance: A4 and `api-e2e:e2e` pass. The review administrator signs in on `api-e2e:client-review-mock`. An unverified email gives a null `driveSubject`.

**DM1.** Scope: the admin-sdk-mock repository, outside this repository. It serves the calls of the mock gap table on `www.googleapis.com` and `sheets.googleapis.com`.
It adds `drive.file` to its scope sets and a per-user file store. A token reads only the files that the app created or that a control route granted.
That control route replaces the Picker grant. Further control routes seed, edit, add a tab to, and delete a file. One refuses the Drive token of a subject with `invalid_grant` or `unauthorized_client`.
The status and hang faults cover the new routes. The media read of `files.get` gets its own route ID, apart from the metadata read.
Acceptance: the mock tests cover each call and the grant rule. A hang on the media read waits before the file lookup, so a deletion during the hang answers 404. Release 0.3.0 ships with its changelog.

**DB5.** Scope: new `gc/drive.ts`, new `gc/drive-fake.mjs`, and the Drive and Sheets entries of `googleRequestAllowed` (`prov:230-245`, `td:998`, `td:368`). It covers the person's token, metadata, the media stream, tabs, value windows, and the three writes.
Acceptance: the `gc/drive.test.mjs` rows of G1 pass. The allowlist refuses every other Drive or Sheets path. Each call sends a `drive.file` token for the given subject. Only `*.test.mjs` files import `gc/drive-fake.mjs`.

**DB6.** Scope: section 5 in `tls` and `edge`, with E1. Acceptance: E1 passes. Every other header and every built path keep their values.

**DB7.** Scope: section 3 in `api/auth/google-connection.controller.ts` and its service, the settings read and save, with A3. Acceptance: A3 passes. A person without `connection:manage` receives 403, and the table stays unchanged.

**DB8.** Scope: the three `/api/google/drive` routes in a new `api/drive/` module and its wiring in `api/app.module.ts`, with A1. It adds `api/src/app/drive/*.test.mjs` to the `api:test` command (`api/project.json:78`).
Acceptance: the `api:test` output names each A1 test, and each passes. No answer, log, or cache entry outside the session route holds a token.

**DB9.** Scope: section 6 worker steps in `worker/src/device-export.ts` and the Drive client wiring in `worker/src/google-connection.ts`, with W1. Acceptance: W1 passes. A cancel before the stamp ends Cancelled and leaves no Sheet.

**DBA.** Scope: section 7 worker steps in `worker/src/device-import.ts`, with W2. Acceptance: W2 passes. A Drive source and its CSV twin give the same report.

**DBB.** Scope: the Sheet export check in `api/devices/device-exports.ts` and the Drive import route in `api/devices/device-imports.controller.ts` and `api/devices/device-imports.ts`. It owns the A2 export and import rows.
Acceptance: those rows pass. Another person's file ID answers 404, because Google refuses it to the subject.

**DBC.** Scope: the `exportFile` and `importSource` mapping in `api/jobs/jobs.ts`, with the A2 job rows. Acceptance: those rows pass. The link holds the stored ID only.

**DM2.** Scope: the 0.3.0 pin in `package.json` and `package-lock.json`, by the steps of `docs/testing/admin-sdk-mock.md:136-146`, with W3.
It adds `sheets.googleapis.com` to `MOCK_GOOGLE_HOSTS` (`api-e2e/admin-sdk-mock-fixture.mjs:17-23`). It returns `drive-files` to G2, which then expects seven passed checks.
Acceptance: W3, G2 on 0.3.0, and `api-e2e:admin-sdk-mock-fixture-test` pass. No file under `api/src`, `worker/src`, `frontend/src`, or `libs/*/src` imports the mock, except `*.test.mjs` files.

**DF1.** Scope: states 01 to 04, built behaviors 1, 3 to 7 for export, the access read, C1, and C2. It updates `frontend-e2e/src/device-export-import.spec.ts` for the Format group.
Drafted strings: the notes strings of states 01 to 04 (`notes:526-540`). Also drafted, for states the mockup does not draw:

- The export alert after cause `account`: "Google refused Drive access for your account. Export a CSV file instead."
- The `drive-unavailable` failure line repeats that alert. The `sheet-write-failed` line: "Google Sheets stopped the export. The Sheet in your Google Drive is incomplete. Export again."
- The short failure labels "Drive unavailable" and "Sheet write failed". The running and ready grid lines: "Creating Google Sheet" and "Google Sheet ready".
- The 503 alert: "Google Drive is not reachable. Try again, or export a CSV file."

Acceptance: on a mocked API the dialog matches states 01 to 04. Reports shows no Google Sheet card.

**DF2.** Scope: states 05 to 13 and built behaviors 2 to 8 for import. It adds the Picker double under `frontend-e2e/src/`, the browser header read, C1, and C2.
It updates `frontend-e2e/src/device-import-dialog.spec.ts` and `frontend-e2e/src/device-export-import.spec.ts` for the Source group.
Drafted strings: the notes strings of states 05 to 13 (`notes:542-585`). Also drafted:

- "The Google Picker did not open. Try again, or upload a CSV file."
- "Google Drive is not reachable. Try again, or upload a CSV file."
- "Campus Commander cannot read the tabs of this Sheet. Choose the file again."
- `wrong-file-type`: "Choose a Google Sheet or a CSV file." `source-too-large`: "The file holds more than 1 GiB of data. Remove rows or columns, then import again."
- `rows-too-large`: "1,000 rows of this tab hold more than 64 MiB of data. Shorten the long cells, then import again."
- The short refusal labels "Drive file unavailable", "File too large", and "Rows too large".

Acceptance: the dialog matches states 05 to 13. The Picker double receives the session token. Cancel in the Picker leaves state 05 unchanged.
The production build loads `https://apis.google.com/js/api.js`, and only `frontend-e2e/` holds the double.

**DF3.** Scope: states 14 to 16, built behaviors 9 and 10, C1, and C3.
Drafted strings: the notes strings of states 14 to 16 (`notes:587-615`). Also drafted:

- "Enter the 39-character API key." and "Enter the project number. It holds digits only."
- "Campus Commander did not save the Drive settings. Try again."
- The evidence line of `drive-files`, which DB2 writes: "Not verified on a live domain. The Drive slice demonstration verifies it."

Acceptance: the page matches states 14 and 15 in both themes. Diagnostics matches state 16 and lists seven scopes.

**DQ1.** Scope: the Drive steps of `record:435-437` on `api-e2e:client-review-mock` with admin-sdk-mock 0.3.0, with screenshots. Its Playwright browser routes the Picker script to the DF2 double and the header read to the mock.

- Open the Drive card before setup: states 11 and 14. Save the settings, then run the Drive check: state 15.
- Export 48 devices to a Google Sheet. Cancel pending work disappears in Create Google Sheet, and the cancel route answers `nothing-to-stop`.
- The mock holds the Sheet in My Drive with text cells, the text format, and the frozen header. Open in Google Sheets opens its link.
- Edit the Sheet and add a tab through the mock. The Picker opens with the session token, and the import reads the chosen tab.
- Choose a Drive CSV file, and wait for the header check. Then add a 10-second `hang` fault, count 1, on the media read of DM1. The harness runs the mock at time scale 1, so the hold lasts 10 seconds (`api-e2e/admin-sdk-mock-fixture.mjs:244`).
- Select Start validation. The route reads the file metadata and creates the validation job. When the fault reads 0 remaining, the mock holds the worker read (`api-e2e/device-write-attacks.mjs:1392-1393`). Delete the file through the mock during the hold. The held read answers 404, and the job fails with `drive-source-unavailable`: state 13 (`notes:113`, `notes:142`).
- Refuse the Drive token with `unauthorized_client` through the mock: states 04 and 16. Refuse it with `invalid_grant`: state 12, and the CSV upload still works.
- Acceptance: each step shows the actual outcome. Lint, tests, and builds of the affected projects pass.

**DQ2.** Scope: the demonstration of `record:435-436` and the read checks of `td:1005-1006` and `td:1008`, with the owner. It runs under the standing authorization (`AGENTS.md:40-48`).
It covers the read items that the mockup leaves unverified (`notes:345-349`). Every Google call is a read. The card creates, edits, and shares no Google file.
Preconditions, which the owner completes:

- A fresh installation with his sign-in client, which allows the `email` scope of DB4 (`docs/testing/fresh-install-review.md:19-20`).
- The Google connection holds the client and the customer of the standing authorization (`AGENTS.md:40-41`).
- The service-account project enables the Google Drive, Google Sheets, and Google Picker APIs (`td:966`).
- A browser key restricted to the Picker API, and the project number (`td:967-968`).
- The delegation of that client holds `drive.file` (`AGENTS.md:47`, `td:1008`). The current scope record lacks it (`cred:57-67`).
- He signs in as the delegated subject of that authorization. His My Drive holds one Google Sheet and one CSV file with the edit template header.

Checks:

1. Save the key and the project number. Diagnostics runs the `drive-files` check, and state 16 shows its result.
2. Choose from Google Drive calls the session route. It answers 200 with an expiry at most one hour ahead (`prov:328-335`).
3. The real Picker opens with the saved key and App ID. Record each Google origin of the page and each content security refusal (`td:990`).
4. Pick the Sheet. Record the tab list and the header check. Validation reads the chosen tab (`record:436`).
5. Validation reaches its report. Record the counts, and stop before Execute. The device read of 2026-10-16 found none (`cred:66`). Empty results stand (`AGENTS.md:46`).
6. Repeat checks 4 and 5 with the CSV file.

Acceptance: each check records its actual outcome with a screenshot. The evidence holds no token and no credential value (`AGENTS.md:44`).
A Picker refusal under `no-referrer` goes to the owner as the question of section 5.

**DQ3.** The owner gave the explicit authorization (`record:404`, `td:1007`) on 2026-10-30. The eng-lead asked: "should the live test include one real Sheet export? It creates one Sheet in your My Drive. Reply `yes` or `no`." The owner replied: "yes". It needs one device to select. The device read of 2026-10-16 found none (`cred:66`).
It exports that device to a Google Sheet once and opens the link. With DQ2, it meets the checks of `td:1003-1008`, so a later card sets `qualified: true` (`td:956`).

**Shared files.** Each shared file sits on one dependency path.

| File                                                                                     | Cards, in merge order |
| ---------------------------------------------------------------------------------------- | --------------------- |
| `libs/google-connection/src/lib/provider.ts`                                             | DB2, DB5              |
| `libs/google-connection/src/lib/capability-health-mock.test.mjs`                         | DB2, DM2              |
| `api/src/app/jobs/jobs.ts`                                                               | DB1, DBC              |
| `worker/src/google-connection.ts`                                                        | DB9, DBA              |
| `api/src/app/auth/google-connection.service.ts`                                          | DB7, DB8              |
| `frontend/src/app/devices/device-export-import-dialog.*` and its store                   | DF1, DF2              |
| `frontend/src/app/devices/device-export-messages.ts`, `device-import-messages.ts`        | DF1, DF2              |
| `frontend/src/app/jobs/job-fields.ts`, `job-detail-fields.ts`                            | DF1, DF2              |
| `frontend-e2e/src/device-drive.spec.ts`, `frontend-e2e/src/device-export-import.spec.ts` | DF1, DF2              |

Every other file belongs to one card. DB2 owns `010`, `011`, the six-capability fixtures, `api-e2e/google-connection-preload.cjs`, and `api-e2e/google-health.mjs`.
DB3 owns `007`, `017`, and `deployment/postgres/index.mjs`. DB4 owns `api-e2e/auth.test.mjs` and the provider fixture. DB6 owns `tls` and `edge`. DB8 owns `api/project.json`.
DF3 owns `frontend-e2e/src/google-drive-settings.spec.ts`. DB2, DB4, and DM1 run beside DB1. DF3 runs beside DF1 and DF2, because it shares no file with them.
