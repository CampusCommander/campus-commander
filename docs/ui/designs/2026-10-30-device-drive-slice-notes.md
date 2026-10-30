# Google Drive slice mockup, version 1: Google Sheet export, Google Drive import, and the Drive setup

Proposal mockup for the owner. It is not the built app.
Open `drive-slice-mockup-v1.html` in a browser. The switcher at the bottom left opens the list of the 16 states.
The deep links `#01-sheet-export-dialog` to `#16-diagnostics-drive-check` show each state, on a fresh load and on a hash change.
The deep links `#dark-07-drive-sheet-chosen` and `#dark-14-google-connection-drive` show the two dark captures.

The PNGs in `png/` are the review set. Each one is 1440 px wide at a device scale factor of 1.
The 16 states use the light theme, and the two `dark-` PNGs use the dark theme of the app.

## Approval and build rulings

On 2026-10-30 the owner approved this mockup in the main chat: "approve, all recommended".
The build follows the recommended option of each question under "Questions for the owner":

1. Reports offers a CSV file only. It hides the Google Sheet card until the report Sheet ships in the third slice.
2. The import step checks the header row of a chosen Drive file before Start validation. The browser reads the row with the one-hour Drive token.
3. The Picker lists My Drive only: the Google Sheets and CSV files of the person.
4. A Sheet export lands at the top level of My Drive.
5. The Google connection page shows the saved Picker API key in full.
6. Every person reads the fix in the Drive notes, as the built device notes do.

## Purpose

This mockup is version 1 of the Google Drive slice.
It closes two design gaps of `docs/workflows/batch-update-export-import.md`:

- Gap 2 (rec:372) reads "No frame shows the Google Sheet export, the Picker, or the tab choice."
  States 01 to 13 close it.
- Gap 7 (rec:377) reads "No frame shows the Google connection inputs: the Picker API key and the project number."
  States 14 and 15 close it. State 16 adds the Diagnostics check of the same scope.

The mockup extends the approved CSV slice mockup, version 4, and changes none of its states.
The CSV code of version 4 stays in the HTML unchanged.
The Drive states reuse its dialog, option cards, phases, file item, file card, and help pane.

## Sources

- The governing record `docs/workflows/batch-update-export-import.md` (rec), the technical design `docs/research/batch-update-export-import-technical-design.md` (td), and the design addendum `docs/superpowers/specs/2026-10-28-device-export-import-design.md` (add). Each citation names a line of origin/main `69dc6b8`.
- The app: `frontend/src/app` and `libs/application-contracts/src` of main `69dc6b8`, read from the read-only worktree `docs-one-event-stream`. Its tree equals origin/main. Main builds the CSV slice, so `device-export-import-dialog.html`, `device-export-messages.ts`, and `device-import-messages.ts` hold most dialog strings.
- The approved CSV slice mockup, version 4: the workspace folder `csv-slice-mockup-v4/`, read only. `work/make-template.py` reads its template in place and edits it at asserted anchors. `build.py` asserts that the copied backgrounds equal those of version 4 byte for byte.
- The real capture `q1c-start-connection.png` of the review build of 2026-10-20 (main `0a811bf`): the calibration of the Google connection page.
- `work/source-notes.md`: the source lines that the first builder collected. Several of its line numbers sit 1 to 5 lines off. This file cites each line again after a check against `69dc6b8`.

A first builder wrote the template parts, `render.cjs`, `check-strings.py`, and the calibration.
A second builder completed the build with these fixes:

1. State 13: the file name in the source error broke at its hyphens. It is now an inline token (choice 12).
2. State 15: the sample Picker API key had the form of a real Google API key. A secret scan stops on that form. The sample now keeps only the length of a key.
3. States 14 to 16: the navigation showed the two identity lines of the connection-only branch of `shell.html`. The drawn pages now show the three lines of an installation with customer settings, as the Devices backgrounds do. The navigation items now line up with states 01 to 13.
4. State 03: the Ready chip carried the new-use mark of version 4. The built dialog shows the same chip on its ready file card, so the string counts as app-sourced now.
5. `check-strings.py`: the byte scan applies the term list of the brief to every file. The wider letter scan skips `work/main-src/`, the verbatim app snapshot, where those letters sit inside a field ID.
6. `render.cjs`: a value token inside a sentence joins the string of its sentence.

## Owner direction

His words win over frame labels, because frames can predate his direction.

2026-09-03, feature review notes (rec:123):

> Export creates a CSV or Google Sheet.

2026-10-24, main chat (rec:137):

> We need to start the work on the CSV/Google Drive import export. For google drive we will use the google drive picker.

The same message adds `https://www.googleapis.com/auth/drive.file` to the scopes of the DWD install (rec:139).

2026-10-26, decision D4 (rec:175):

> D4) The signed in persons drive. I have confirmed You came make an oauth token from DWD and pass it to the picker in the client. Ive done this before.

2026-10-28, on version 3 of the CSV slice mockup (rec:287):

> I dont like having the export and import preview. Just the raw data in the dialog. We can do without that. The important UI is the results of the validation and the results of the execution.

2026-10-28, on version 4 (rec:291):

> This is perfect. Please go ahead and execute on this.

His direction on version 1 still places the help. The notes of version 4 record it:

> Any instructions should not be in the normal flow of the UI. Add a help/info icon button that shows the help docs for the import / export.

### Owner rules by state

| Rule | Source | States |
| --- | --- | --- |
| Export writes a CSV file or a Google Sheet | 2026-09-03 | 01 to 04 |
| The Google Picker chooses the Drive file | 2026-10-24 | 05 to 08 |
| `drive.file` joins the DWD install scopes, the delegation link, and Diagnostics | 2026-10-24, rec:102 | 04, 14 to 16 |
| The Drive of the signed-in person, with a DWD token that the browser passes to the Picker | D4 | 01 to 03, 06, 12 |
| Raw data only: no preview of a Sheet, a tab, or a file | Version 3 | 01, 03, 07, 08 |
| The approved compositions of version 4 stay | Version 4 | 01 to 13 |
| Instructions leave the flow, and the info button opens the help | Version 1 | 09 |

## States

| # | PNG | Capture | Content | Source |
| --- | --- | --- | --- | --- |
| 01 | `png/01-sheet-export-dialog.png` | viewport, dialog fixed to it | Export, 480 px, 48 selected devices. The Format cards with Google Sheet selected and its line Saved in your Google Drive. | rec:36, owner 2026-09-03 (rec:123), td:365-371 |
| 02 | `png/02-sheet-export-running.png` | viewport, dialog fixed to it | EXP-003 runs: Write rows 48 of 48 done, Create Google Sheet current, the quiet closing line, and Close. The bell shows the running badge. | td:752, td:855, add:403 |
| 03 | `png/03-sheet-export-ready.png` | viewport, dialog fixed to it | EXP-003 completed: the Sheet card with the name as a link, the Ready chip, the facts, and Saved in your Google Drive. Done and Open in Google Sheets. | rec:39, td:168, td:370 |
| 04 | `png/04-sheet-export-unavailable.png` | viewport, dialog fixed to it | Export with Google Sheet disabled, because the delegation lacks the drive.file scope. The note names the scope and the fix. CSV file stays selected. | td:371, td:1042, rec:102 |
| 05 | `png/05-drive-import-dialog.png` | viewport, dialog fixed to it | Import, 480 px, no selection. Source Google Drive selected: the Drive zone with Choose from Google Drive. Start validation disabled. | rec:57-58, td:188, td:1376 |
| 06 | `png/06-drive-picker.png` | viewport, dialog fixed to it | The Google Picker over the dialog, a neutral sample of the frame of Google: My Drive with five files, the Sheet of EXP-003 selected. A mockup note names the sample. | rec:58, D4 (rec:175), td:587, td:987 |
| 07 | `png/07-drive-sheet-chosen.png` | viewport, dialog fixed to it | The chosen Sheet: the file item with 2 tabs and the Drive edit time, the Tab select on Devices (the first tab), and Header check passed. Start validation enabled. | td:189, td:588, td:921, gap 2 (rec:372) |
| 08 | `png/08-drive-csv-chosen.png` | viewport, dialog fixed to it | A CSV file from Drive: the file item with the size, the columns, and the Drive edit time, and Header check passed. No Tab field. | rec:57, td:592 |
| 09 | `png/09-drive-help.png` | viewport, dialog fixed to it | The help pane docked beside the step of state 07 (1000 px in total) on the new Google Drive topic: Export, Import, and Access. | td:370, td:591, td:593, owner direction on version 1 |
| 10 | `png/10-drive-validation-running.png` | viewport, dialog fixed to it | IMP-010 validates the Devices tab: Read from Google Drive 48 rows, Header check Passed, Refresh stale devices 6 of 9, and the counters 48 and 13. | add:397-404, td:593, td:914 |
| 11 | `png/11-drive-setup-missing.png` | viewport, dialog fixed to it | Import with Google Drive disabled, because the Picker API key and the project number are missing. Upload a CSV file stays selected. | gap 7 (rec:377), td:965-970, td:1042 |
| 12 | `png/12-drive-access-refused.png` | viewport, dialog fixed to it | Google refused the Drive token of this person: Google Drive disabled with the built note, the alert, and Upload a CSV file selected. | td:980-981, td:1042, td:1185-1186 |
| 13 | `png/13-drive-source-lost.png` | viewport, dialog fixed to it | IMP-009 failed: its CSV file left Drive before the read. Read from Google Drive Failed, the source error with the file name, No report, and Import again. | td:594, td:1047, td:1185 |
| 14 | `png/14-google-connection-drive.png` | full page, 1440 x 2,256 | The Google connection page with the new Google Drive card before setup: the scope, the failed Drive check with its recovery, two empty fields, and the setup steps. | gap 7 (rec:377), rec:102, td:958, td:965-970, td:1383 |
| 15 | `png/15-google-connection-drive-saved.png` | full page, 1440 x 1,995 | The same card after Save and a passed check: the saved key and project number, Last check passed, the ready line, and the steps closed. | td:965-970, td:950-956 |
| 16 | `png/16-diagnostics-drive-check.png` | viewport, scrolled in a 4,224 px page | Diagnostics at the Google Drive files check: Delegation not authorized, the recovery, Recheck, and the authorization steps with 7 scopes. | rec:102, td:950-958 |
| D07 | `png/dark-07-drive-sheet-chosen.png` | viewport, dialog fixed to it, dark theme | State 07 in the dark theme of the app. | As state 07 |
| D14 | `png/dark-14-google-connection-drive.png` | full page, 1440 x 2,257, dark theme | State 14 in the dark theme of the app. | As state 14 |

The HTML also shows interactions that no PNG captures:

- The CSV file card of state 01 runs the CSV export of version 4 (EXP-001) to its file card.
- The info button of state 01 opens the help on the Export topic. The Google Drive topic opens from there.
- Export 48 devices in state 01 opens state 02. A click on the phase list ends the job and opens state 03. Done and Escape close the dialog.
- Upload a CSV file in state 05 shows the drop zone of version 4. Google Drive returns to state 05.
- Choose from Google Drive opens state 06. A click on the CSV row selects it, and Select opens state 08. Select on the Sheet row opens state 07.
- Cancel and Escape in the Picker return to state 05. The close button shares the handler of Cancel.
- The info button of state 07 opens the Import topic. The Google Drive topic shows state 09.
- Start validation in state 07 opens state 10. Stop validation ends IMP-010 Cancelled, with No report.
- Import again in state 13 returns to state 05.
- The disabled Google cards of states 04, 11, and 12 ignore a click.
- The info button shows its tooltip on hover. The Sheet name of state 03 fits, so it shows no tooltip.

## Scenario and data

- The person is the review build account, "Review administrator". Times are Friday, Oct 30, 2026, US Eastern, in the app time format.
- The navigation shows example data: `example.org` and the customer ID `C03ex4mpl`. `build.py` erases the identity block of the review screenshots, and the template draws it again. No PNG shows the connected domain or the simulated customer ID of the review build.
- Version 4 supplies the inventory and the selection: 7,000 devices, and the first 48 by serial (states 01 to 04).
- EXP-001 and EXP-002 are the export jobs of version 4. EXP-003 writes the edit export of the 48 devices as the Google Sheet `devices-for-editing-EXP-003`. The Sheet sits in My Drive of the person and holds 48 rows and the 10 template columns.
- The person edits the Sheet at 11:02 AM and adds a second tab. Devices stays the first tab.
- IMP-001 to IMP-008 are the import jobs of version 4. IMP-010 validates the Devices tab in Sync changes at 11:05 AM. It reads 48 rows, finds 13 edited rows, and refreshes 6 of 9 stale devices.
- `devices-for-editing-EXP-001.csv` is the CSV file of EXP-001 in the Drive of the person. It holds 7.8 KB and 10 columns, and its last edit was Oct 29, 4:12 PM. IMP-009 chose it, and the file left Drive before the worker read it.
- The Picker lists five files of My Drive, each owned by "me". They are the Sheet of EXP-003, the CSV file of EXP-001, `library-reset`, `loaner-carts.csv`, and `Room 12 inventory`.
- States 14 to 16 use example data: the domains `example.org` and `k12.example.org`, and the client ID `100000000000000000001`. The delegated administrator is `admin@example.org`. The encryption key ID `synthetic-google-key` is the sample of the review build.
- The sample Picker API key `synthetic-picker-api-key-00000000000000` holds 39 characters. It has the length of a Google browser key, but not its form. The sample project number is `123456789012`.

## Fidelity and calibration

Backgrounds:

- States 01 to 13 use the composed real screenshots of version 4, from the review builds of 2026-10-22 and 2026-10-23. `bg-devices-sel-1440x900.png` holds the 48 selected devices (states 01 to 04). `bg-devices-none-1440x900.png` holds no selection (states 05 to 13).
- `bell-running.png` is the real bell crop of version 4. States 02 and 10 show it, because a job runs.
- States 14 to 16 have no background screenshot. The template draws the shell and the page from the app source of `69dc6b8`. It copies `shell.html`, `shell.css`, `google-connection.html`, `credential-management.html`, `google-connection.css`, `diagnostics.html`, and `diagnostics.css`.
- As in version 4, the dialogs use the Angular Material 22 CSS of `work/material/` and the app theme of `work/theme/`. Version 4 calibrated the dialog shell, the menu, and the status bar against real captures.
- The dark captures have no dark screenshot of the review build. In state D07, a drawn Devices page with the dark tokens of `tokens.css` replaces the screenshot, as in version 4. State D14 draws its page with the same tokens and the compiled theme in the dark color scheme.

Calibration:

`work/cal/cal.py` draws the connected Google connection page in a calibration variant.
It diffs the drawing against the real capture `q1c-start-connection.png` (1440 x 1438).
The pass mark is a mean absolute difference under 0.2 per pixel and channel, on the 0 to 255 scale.
The control compares each region with a blank page surface.
All 13 regions pass with a worst mean of 0.000. The controls run from 5.0 to 28.7.

| Region | Box (x0, y0, x1, y1) | Mean | Control |
| --- | --- | --- | --- |
| nav-heading | 0, 0, 239, 72 | 0.000 | 13.926 |
| nav-top-items | 0, 136, 239, 280 | 0.000 | 11.880 |
| nav-lower-items | 0, 348, 239, 584 | 0.000 | 12.470 |
| header | 240, 0, 1440, 63 | 0.000 | 8.713 |
| main-top | 240, 64, 1440, 345 | 0.000 | 6.106 |
| connected-heading | 480, 362, 1200, 425 | 0.000 | 8.164 |
| connected-times | 480, 562, 1200, 660 | 0.000 | 10.405 |
| domains-heading | 480, 770, 1200, 805 | 0.000 | 7.440 |
| connected-end | 480, 865, 1200, 960 | 0.000 | 9.972 |
| credentials-heading | 480, 983, 1200, 1048 | 0.000 | 9.825 |
| credentials-rows | 480, 1095, 1200, 1255 | 0.000 | 8.896 |
| credentials-actions | 480, 1285, 1200, 1352 | 0.000 | 28.702 |
| footer | 0, 1398, 1440, 1438 | 0.000 | 5.026 |

- The regions leave out the tenant data of the capture. That data is the navigation identity, the customer ID, the client ID, the domains, and the delegated administrator. The regions also leave out the Customer settings row under the focused skip link and a hovered button.
- The calibration variant keeps the two identity lines of the capture, the connection-only branch of `shell.html`. States 14 to 16 show three lines (fix 3).
- The Google Drive card and the Diagnostics page have no real capture. They copy the built CSS and DOM without a calibration.

The source of the Google connection page:

- The capture comes from main `0a811bf`. Since then, main changed one sentence of the setup step of `google-connection.html` (`git diff 0a811bf origin/main`).
- The connected page does not show the setup step, so the capture still matches `69dc6b8`. The docstring of `work/cal/cal.py` records the comparison.

Full-page captures:

- States 14 and 15 capture a page taller than the viewport: 1440 x 2,256 and 1440 x 1,995.
- The dark capture of state 14 is 1440 x 2,257. The page height of state 14 rounds to 2,256 px in the PNG run. A fresh load and the dark theme give 2,257 px. The footer stays at the bottom in each.
- State 16 is a viewport capture of the 4,224 px Diagnostics page. The capture scrolls the page until the Google Drive files check starts 36 px below the top.

Render checks (`render.cjs`, `render-report.json`):

- Every request except `file:` and `data:` aborts. The render made 4 requests, with 0 page errors, 0 console errors, and 0 aborted requests.
- It found 0 problems in the 18 PNG states and in 7 live variants. The checks cover overflow, clipping, scrolling, width, word breaks, and contrast.
- It checked 2,215 words, and no word breaks over two lines. The PNG states hold 0 cut values.
- Every visible text meets 4.5 to 1 against its composed background (3 to 1 for large text), in both themes. The lowest contrast is 4.51 to 1.
- The click test covers the Format and Source cards, the export run, and the help topics. It covers the Picker rows, Cancel, Escape, and the validation actions. It ends with the tooltips, Escape, and the deep links on a fresh load and on a hash change.

Byte scans: `work/clean-png.py` re-encodes a PNG losslessly when its compressed bytes hold a forbidden letter sequence by chance.
The final render re-encoded `png/13-drive-source-lost.png` once.
`check-strings.py` then finds 0 forbidden letter sequences and 0 tenant identifiers in the folder.

## Composition choices

Build cards cite these numbers. Each choice extends a composition of version 4 and changes none of its states.

1. Format (state 01).
   Google Sheet is the second Format card, under CSV file.
   While Drive is available, its line reads "Saved in your Google Drive".
   The action keeps the count for both formats: "Export 48 devices".
   The step shows no preview of the Sheet (version 3 direction).
2. Sheet export progress (state 02).
   The phases read "Write rows", then "Create Google Sheet".
   The worker writes the Sheet last. After that write starts, the job page offers no Cancel pending work (td:855).
   The Sheet phase shows no count and no bar.
   The running step offers Close only, as version 4 does.
3. The ready Sheet (state 03).
   The file card of version 4 shows the Sheet with the table glyph, and the Sheet name links the Sheet.
   The facts read "Google Sheet · 48 rows · 10 columns".
   The line "Saved in your Google Drive" replaces the expiry, because the person owns the Sheet (td:370).
   "Open in Google Sheets" is the primary action and opens a new tab. Done closes the dialog.
   - The Sheet takes the name of the CSV file without ".csv". Its tab is Devices. Question 4 asks where the Sheet goes.
4. Unavailable Google choices (states 04, 11, and 12).
   The Google card stays in place, disabled, with its cause under the label.
   CSV stays available. Each cause has its own note:
   - The person: the built note "Google Drive is not available for your account." (state 12).
   - The delegation lacks `drive.file` (state 04). The note copies the form of the built device note of `device-fields.ts`: "Google denied Drive access. Add https://www.googleapis.com/auth/drive.file to the delegation client in the Google Admin Console."
   - The setup inputs are missing: "Google Drive needs the Picker API key and the project number. Add them on the Google connection page." (state 11).
   - After a refused token exchange, the dialog selects Upload a CSV file and shows an alert (state 12). The alert reads "Google refused Drive access for your account. Upload a CSV file instead."
5. The Drive source (state 05).
   Google Drive is the second Source card.
   Its zone keeps the shape of the drop zone. It holds the Drive glyph, "A Sheet or a CSV file", and the outlined button "Choose from Google Drive".
   The subtitle reads "Google Drive · Not submitted".
   Start validation stays disabled until the person chooses a file.
6. The Google Picker (state 06).
   The Picker opens over the dialog in the frame of Google, at its largest size of 1051 x 650 px.
   Campus Commander does not style it.
   It lists the Google Sheets and CSV files of My Drive and allows one file (td:987).
   Cancel and Escape return to state 05 unchanged.
   The mockup draws a neutral sample without a Google mark, under a mockup note.
7. The chosen Sheet (state 07).
   The file item of version 4 holds the Sheet name. Its facts read "Google Sheet · 2 tabs · Edited Oct 30, 11:02 AM".
   An outlined Tab select follows, on the first tab (td:189).
   The header check line follows the Tab select and reports on that tab.
   Start validation turns enabled.
8. A CSV file from Drive (state 08).
   The file item of version 4 holds the size, the column count, and the Drive edit time.
   It shows no row count before validation, because the header check reads only the start of the file (question 2).
   It has no Tab select.
9. The Google Drive help topic (state 09).
   The help gains a fifth topic, Google Drive, after Review.
   The Import topic of version 4 already fills the pane, so the Drive rules take their own topic.
   The topic holds three groups: Export, Import, and Access.
   It states that hidden and filtered rows count as rows (td:591).
   The pane docks beside the 480 px step, as in version 4.
10. Validation of a Drive source (state 10).
    Phase 1 reads "Read from Google Drive" instead of "Upload" and shows the rows read.
    The worker stores what it read, so later Drive edits change nothing (td:593).
    The second subtitle line names the mode, the Sheet, and the tab: "Sync changes · devices-for-editing-EXP-003 › Devices".
    The other phases, the counters, and Stop validation stay as in version 4.
11. A lost Drive source (state 13).
    The failed step of version 4 shows the failure, and phase 1 reads Failed.
    The alert names the file and the next step.
    No other file or tab replaces the source (td:1047).
    Import again returns to state 05 with no file chosen.
12. No value breaks inside itself (states 07, 08, 10, and 13).
    A file name, a Sheet name, or a tab name keeps one line.
    Inside a sentence, it moves whole to the next line.
    When it does not fit its box, it ends in an ellipsis. A `matTooltip` then shows the full value, as choice 25 of version 4 rules.
    No value of the scenario needs the ellipsis.
13. The Google Drive card (states 14 and 15).
    The Google connection page gains a third card, "Google Drive", after Background Google credentials.
    It lists the Drive scope and the Drive check. A failed check adds the built recovery text, the built delegation link, and its line.
    Two outlined fields with hints follow: Picker API key and Project number.
    Save Drive settings is the filled action, beside the outlined Check Google access.
    The five setup steps sit in a details element, open until the first save.
14. The Drive check of Diagnostics (state 16).
    The capability "Google Drive files" (`drive-files`) joins the Google access card as the seventh check.
    A failed check shows the built recovery text of `google-health.ts`.
    The setup steps add the Google Drive, Google Sheets, and Google Picker APIs.
    The scope list adds `drive.file` and holds 7 scopes.
15. Mockup only.
    The state switcher is a pill at the bottom left of the viewport, also over the full-page captures.
    The note over the Picker is a mockup annotation. The header pill "Proposal mockup, not the built app" marks every PNG.

## Questions for the owner

Only points that the sources do not settle. Each question lists its options, with the recommended option first.
Answer with the question number and the option number, for example "1.1".

1. Reports and Google Sheet.
   Export offers Google Sheet in this slice. The technical design adds the Google Sheet report in the third slice (td:100).
   What does the Reports dialog show for Google Sheet until then?
   1. CSV file only. Reports hides the Google Sheet card until the report Sheet ships. (Recommended)
   2. The Google Sheet card stays disabled, with a note that names the later release.
   3. Reports offers Google Sheet in this slice too.
2. The header check of a Drive file.
   The import step checks the header of an uploaded CSV file in the browser before Start validation (td:581).
   The sources name no such check for a Drive file. States 07 and 08 show one.
   1. Check the header row before Start validation, as states 07 and 08 show. The browser reads the row with the one-hour Drive token. (Recommended)
   2. No early check. The validation job checks the header, and a wrong header fails the job.
3. The files that the Picker lists (state 06).
   1. My Drive only: the Google Sheets and CSV files of the person (td:587). (Recommended)
   2. My Drive, shared drives, and the files that others share with the person.
4. The place of the export Sheet (state 03).
   1. The top level of My Drive. (Recommended)
   2. A "Campus Commander" folder in My Drive. The first Sheet export creates it.
5. The saved Picker API key (state 15).
   1. Show the whole key. Every browser that opens the Picker receives it anyway. (Recommended)
   2. Show only its last 4 characters.
6. The readers of the Drive fix (states 04 and 11).
   The notes tell the person to change the delegation or the Google connection page.
   1. Every person reads the fix, as the built device notes do. (Recommended)
   2. A person who cannot change the Google connection reads only "Google Drive is not available for your account."

## Issues found

These items go to engineering, not to the owner.

Per-field limits:

- Picker API key: the sources set no length and no character rule. A Google browser API key holds 39 letters, digits, hyphens, and underscores. The sample keeps the length.
- Project number: the field takes digits only (`inputmode="numeric"`). The sources set no length. The sample holds 12 digits.
- Sheet, tab, and file names: Google sets their length, not Campus Commander. A long name takes the ellipsis and the tooltip of choice 12. The mockup draws no long name.
- The Sheet export keeps the limit of the edit export (td:171). An export above 50,000 devices stops before the job starts. No state shows the limit for a Sheet.

Inherited defects:

- The subtitle items of version 4 (`jobSub`) are nowrap spans without an ellipsis. A long Sheet name, tab name, or file name overflows the 480 px dialog in states 10 and 13. The build gives each item the token of choice 12.
- The ready CSV card of version 4 marks "Ready" as an app literal with a new meaning. The built dialog now shows the same chip (`device-export-import-dialog.html`), so the mark is stale. State 03 drops it. The CSV code of version 4 stays unchanged.
- The built app writes "Google Admin Console" in `device-fields.ts` and "Google Admin console" in `google-connection.html`. The note of state 04 follows `device-fields.ts`.

Source contradictions:

- The referrer policy. Risk 5 of the record (rec:412) says that the Picker needs a change to the referrer policy. The technical design keeps `no-referrer` and restricts the API key by API only (td:991-992). State 14 follows the technical design. A change of the referrer policy changes its step 3 and the key hint. Step 3 reads "Add no website restriction to the key."
- The hidden-rows rule. The technical design says that the import sheet states the rule (td:591). The owner moved instructions out of the flow on 2026-10-28. State 09 states the rule in the Google Drive help topic, because his words win.

## What the mockup does not verify

- The real Picker. Its frame, words, size, and behavior belong to Google. State 06 draws a neutral sample, and no Google call ran.
- The DWD token path of D4 (td:977-978). The API mints a `drive.file` token for the person, and the Picker accepts it. A spike settles it.
- A live Sheet export. It creates a Google file and needs explicit owner authorization (rec:404).
- The reads of the worker: formatted tab values, hidden and filtered rows, and the CSV parse of a Drive file.
- The edge script and frame rules for the origins of the Picker (td:989-990).
- The drafted parts of states 14 to 16: the Google Drive card, the `drive-files` check, and the new setup steps. The calibration covers only the built cards of the connection page.
- The tooltip of a cut value in a capture. No value of the PNG states needs the ellipsis, so only the code path holds the tooltip.
- A screen reader. The render checks the accessible names as strings only.

## App-sourced strings

The PNG states show 220 distinct strings. Each one sits in one of the five lists below.

This list holds 134 strings. 97 are whole literals or element texts of the app.
An app template or rule builds the other 37 with mockup data.
Each item names its proof in the app of `69dc6b8`. `check-strings.py` reads the strings from `render-report.json`.

- "Selected on current page: 48" · rule: ssrmSelectionService.js
- "Total Selected: 48" · rule: ssrmSelectionService.js
- "Select All (7000)" · rule: ssrmSelectionService.js
- "Deselect All" · rule: ssrmSelectionService.js
- "Show All Selected (48)" · rule: ssrmSelectionService.js
- "7,000 matching devices · 7,000 in district" · rule: device-status-panel.ts
- "Inventory observed Oct 27, 6:05 AM" · rule: device-status-panel.ts
- "CSV file" · frontend/src/app/devices/device-export-messages.ts
- "Google Sheet" · frontend/src/app/devices/device-export-messages.ts
- "Cancel" · frontend/src/app/devices/device-export-import-dialog.html
- "Export 48 devices" · device-export-messages.ts: Export ${count.toLocaleString(en-US)} ${count === 1 ? device : devices}
- "Export devices" · frontend/src/app/devices/device-export-messages.ts
- "48 selected devices · Not submitted" · device-action-sheet.ts: ${count.toLocaleString(en-US)} selected ${ count === 1 ? device : devices } · Not su
- "Format" · frontend/src/app/devices/device-export-messages.ts
- "Export and import help" · frontend/src/app/devices/device-export-import-dialog.html
- "Close" · frontend/src/app/devices/device-action-sheet.html
- "Write rows" · frontend/src/app/devices/device-export-import-dialog.ts
- "Completed" · frontend/src/app/jobs/job-fields.ts
- "48 of 48" · rule: device-export-import-dialog.ts, device-import-messages.ts
- "Closing this dialog keeps the export running." · frontend/src/app/devices/device-export-messages.ts
- "Job EXP-003 · Running" · rule: device-export-import-dialog.html, device-export-import-dialog.ts, job-fields.ts
- "Export phases" · frontend/src/app/devices/device-export-import-dialog.html
- "Ready" · frontend/src/app/devices/device-export-import-dialog.html
- "Done" · frontend/src/app/devices/device-action-sheet.html
- "Job EXP-003 · Completed" · rule: device-export-import-dialog.html, device-export-import-dialog.ts, job-fields.ts
- "48 rows" · rule: device-export-messages.ts
- "10 columns" · rule: device-import-messages.ts
- "Selected on current page: 0" · rule: ssrmSelectionService.js
- "Total Selected: 0" · rule: ssrmSelectionService.js
- "Show All Selected (0)" · rule: ssrmSelectionService.js
- "Bulk Actions" · frontend/src/app/devices/devices.html
- "Sync changes" · frontend/src/app/devices/device-import-messages.ts
- "Sync all rows" · frontend/src/app/devices/device-import-messages.ts
- "Upload a CSV file" · frontend/src/app/devices/device-import-messages.ts
- "Google Drive" · frontend/src/app/devices/device-import-messages.ts
- "Start validation" · frontend/src/app/devices/device-export-import-dialog.ts
- "Import devices" · frontend/src/app/devices/device-export-messages.ts
- "Import mode" · frontend/src/app/devices/device-import-messages.ts
- "Source" · frontend/src/app/devices/device-import-messages.ts
- "Header check passed." · frontend/src/app/devices/device-import-messages.ts
- "Selected file" · frontend/src/app/devices/device-import-messages.ts
- "7.8 KB" · frontend/src/app/devices/device-export-messages.ts
- "Export" · frontend/src/app/devices/device-export-messages.ts
- "Reports" · frontend/src/app/devices/device-export-messages.ts
- "Import" · frontend/src/app/devices/device-export-messages.ts
- "Review" · frontend/src/app/devices/device-action-sheet.ts
- "Help topic" · frontend/src/app/devices/device-export-help.html
- "Header check" · frontend/src/app/jobs/job-fields.ts
- "Passed" · frontend/src/app/devices/device-import-messages.ts
- "Refresh stale devices" · frontend/src/app/jobs/job-fields.ts
- "6 of 9" · rule: device-export-import-dialog.ts, device-import-messages.ts
- "Compare" · frontend/src/app/jobs/job-fields.ts
- "Report" · frontend/src/app/jobs/job-fields.ts
- "Rows read" · frontend/src/app/devices/device-import-messages.ts
- "Edited rows" · frontend/src/app/devices/device-import-messages.ts
- "Closing this dialog keeps the validation running." · frontend/src/app/devices/device-import-messages.ts
- "Stop validation" · frontend/src/app/devices/device-import-messages.ts
- "Job IMP-010 · Running" · rule: device-export-import-dialog.html, device-export-import-dialog.ts, job-fields.ts
- "Validation phases" · frontend/src/app/devices/device-export-import-dialog.html
- "Refresh stale devices progress" · rule: device-export-import-dialog.html, job-fields.ts
- "Drop a CSV file here" · frontend/src/app/devices/device-import-messages.ts
- "Choose CSV file" · frontend/src/app/devices/device-import-messages.ts
- "CSV file · Not submitted" · frontend/src/app/devices/device-import-messages.ts
- "Google Drive is not available for your account." · frontend/src/app/devices/device-export-messages.ts
- "Failed" · frontend/src/app/devices/device-import-messages.ts
- "No report" · frontend/src/app/devices/device-import-messages.ts
- "Import again" · frontend/src/app/devices/device-import-messages.ts
- "Job IMP-009 · Failed" · rule: device-export-import-dialog.html, device-export-import-dialog.ts, job-fields.ts
- "Sync changes · devices-for-editing-EXP-001.csv" · rule: device-edit-template.ts, device-export-import-dialog.ts
- "Validation stopped before any row check. No report and no plan exist. Nothing reached Google." · frontend/src/app/devices/device-import-messages.ts
- "Campus Commander" · frontend/src/app/app.ts
- "Devices" · frontend/src/app/devices/devices.html
- "Jobs" · frontend/src/app/jobs/jobs.html
- "Google connection" · frontend/src/app/schools/schools.html
- "Customer settings" · frontend/src/app/customer-settings/customer-settings.html
- "Your account" · frontend/src/app/account/account.html
- "Diagnostics" · frontend/src/app/diagnostics/diagnostics.html
- "Schools" · frontend/src/app/platform-access/scoped-grants.html
- "Platform access" · frontend/src/app/platform-access/platform-access.html
- "Platform invitations" · frontend/src/app/invitations/invitations.html
- "Google customer connection" · frontend/src/app/google-connection/google-connection.html
- "Refresh saved status" · frontend/src/app/google-connection/google-connection.html
- "Service account client ID" · frontend/src/app/google-connection/google-connection.html
- "Delegated administrator" · frontend/src/app/google-connection/google-connection.html
- "Confirmed" · frontend/src/app/google-connection/google-connection.html
- "Last successful Google read" · frontend/src/app/google-connection/google-connection.html
- "Google customer ID" · frontend/src/app/customer-settings/customer-settings.html
- "Primary domain" · frontend/src/app/customer-settings/customer-settings.html
- "Domains" · frontend/src/app/google-connection/google-connection.html
- "example.org — Primary domain. Verified." · rule: google-connection.html
- "Check Google access" · frontend/src/app/diagnostics/diagnostics.html
- "Refresh credential status" · frontend/src/app/google-connection/credential-management.html
- "Background access" · frontend/src/app/google-connection/credential-management.html
- "Encryption key ID" · frontend/src/app/google-connection/credential-management.html
- "Credential generation" · frontend/src/app/google-connection/credential-management.html
- "Replace Google credentials" · frontend/src/app/google-connection/credential-management.html
- "Rotate encryption key" · frontend/src/app/google-connection/credential-management.html
- "Disconnect background access" · frontend/src/app/google-connection/credential-management.html
- "Version development · Build client-review" · rule: shell.html
- "Services ready" · rule: shell.html
- "Google: 1 of 7 capabilities need attention" · health.store.ts: Google: ${failed} of ${setup.length} capabilities need attention
- "Development review. Google sign-in and Workspace data are simulated. Use the sample service-account file. Do not upload real credentials." · rule: shell.html
- "Connect your organization to Google Workspace." · frontend/src/app/google-connection/google-connection.html
- "Customer connected" · frontend/src/app/google-connection/google-connection.html
- "Connected Google customer: C03ex4mpl." · google-connection.html: Connected Google customer: ${x}.
- "k12.example.org — Alias. Verified." · rule: google-connection.html
- "These domains came from the last successful Google check." · frontend/src/app/google-connection/google-connection.html
- "Background Google credentials" · frontend/src/app/google-connection/credential-management.html
- "Credential active" · frontend/src/app/google-connection/credential-management.html
- "Google customer: C03ex4mpl. Credential changes preserve this customer and its settings." · rule: credential-management.html
- "Delegation not authorized" · libs/application-contracts/src/lib/google-health.ts
- "Verify the service-account numeric client ID and this capability scope in domain-wide delegation. Recheck after approval propagates." · libs/application-contracts/src/lib/google-health.ts
- "Open domain-wide delegation in the Google Admin console." · rule: google-connection.html
- "This link opens Google Admin with the client ID and these scopes filled in. Authorize replaces the scope list of that client with the listed scopes." · frontend/src/app/diagnostics/diagnostics.html
- "Application navigation" · frontend/src/app/shell/shell.html
- "Toggle navigation" · frontend/src/app/shell/shell.html
- "Activity: no jobs running" · job-activity.ts: Activity: ${running}
- "Help" · frontend/src/app/account/account.html
- "Choose theme" · frontend/src/app/shell/shell.html
- "Open user menu" · frontend/src/app/shell/shell.html
- "Google: 7 last checks passed" · health.store.ts: Google: ${setup.length} last checks passed
- "Last check passed" · frontend/src/app/diagnostics/diagnostics.html
- "Configure required Google authorization" · frontend/src/app/diagnostics/diagnostics.html
- "Open domain-wide delegation in the Google Admin console" · frontend/src/app/devices/devices.html
- "." · frontend/src/app/diagnostics/diagnostics.html
- "Copy service account client ID" · frontend/src/app/diagnostics/diagnostics.html
- "Copy required Google scopes" · frontend/src/app/diagnostics/diagnostics.html
- "Checked 40 seconds ago" · diagnostics.html: Checked ${x} seconds ago
- "Required scope: Not verified in the last check." · diagnostics.html: Required scope: ${x}.
- "Add these 7 scopes to allow the checks on this page." · diagnostics.html: Add these ${x} scopes to allow the checks on this page.
- "Add the service-account numeric client ID and the required scopes below." · frontend/src/app/diagnostics/diagnostics.html
- "Service account client ID: 100000000000000000001" · rule: diagnostics.html
- "Google needs time to apply delegation changes. Run the check again after the change takes effect." · frontend/src/app/diagnostics/diagnostics.html
- "Required Google capability scopes" · frontend/src/app/diagnostics/diagnostics.html

## Mockup data

17 strings: file names, IDs, counts, times, the person, and the example identity.

- "2" · state 02
- "devices-for-editing-EXP-003" · state 03
- "devices-for-editing-EXP-001.csv" · state 08
- "3" · state 10
- "4" · state 10
- "5" · state 10
- "48" · state 10
- "13" · state 10
- "example.org" · state 14
- "C03ex4mpl" · state 14
- "Review administrator" · state 14
- "100000000000000000001" · state 14
- "admin@example.org" · state 14
- "Oct 20, 2026, 6:48:11 PM" · state 14
- "Oct 30, 2026, 10:12:40 AM" · state 14
- "synthetic-google-key" · state 14
- "1" · state 14

## Drafted strings

47 strings, including 1 app literal with a new meaning. The owner approves each one.
The note of state 04 copies the form of the built device note of `device-fields.ts`.
The setup steps of state 14 follow sections 16.2 and 16.4 of the technical design.
Three drafted strings quote the technical design: "Google Drive files" (td:952), the tab rule (td:189), and the hidden-rows rule (td:591).

### State 01, sheet-export-dialog

- "Saved in your Google Drive"

### State 02, sheet-export-running

- "Create Google Sheet"

### State 03, sheet-export-ready

- "Open in Google Sheets"

### State 04, sheet-export-unavailable

- "Google denied Drive access. Add https://www.googleapis.com/auth/drive.file to the delegation client in the Google Admin Console."

### State 05, drive-import-dialog

- "A Sheet or a CSV file"
- "Choose from Google Drive"
- "Google Drive · Not submitted"

### State 07, drive-sheet-chosen

- "Tab"
- "2 tabs"
- "Edited Oct 30, 11:02 AM"

### State 08, drive-csv-chosen

- "Edited Oct 29, 4:12 PM"

### State 09, drive-help

- "Access"
- "Google Sheet export and Google Drive import use your own Google Drive."
- "A Google Sheet export creates a Sheet in your Google Drive. You own the Sheet."
- "Campus Commander keeps only the link. Share the Sheet in Google Drive."
- "Choose from Google Drive opens the Google Picker. It lists your Google Sheets and CSV files."
- "For a Google Sheet, choose the tab. The first tab starts selected."
- "Hidden and filtered rows count as rows."
- "Validation reads the file when it starts. Import again after later edits."
- "Campus Commander opens only its own files and the files that you choose."

### State 10, drive-validation-running

- "Read from Google Drive"
- "Sync changes · devices-for-editing-EXP-003 › Devices"

### State 11, drive-setup-missing

- "Google Drive needs the Picker API key and the project number. Add them on the Google connection page."

### State 12, drive-access-refused

- "Google refused Drive access for your account. Upload a CSV file instead."

### State 13, drive-source-lost

- "Campus Commander cannot read devices-for-editing-EXP-001.csv from Google Drive. Choose the file again in Google Drive, then import again."

### State 14, google-connection-drive

- "Drive scope"
- "Drive check"
- "Picker API key"
- "A browser API key of the service-account project. Restrict it to the Google Picker API."
- "Project number"
- "The Picker uses this number as its App ID. Google Cloud shows it on the project dashboard."
- "Save Drive settings"
- "Configure Google Drive"
- "Google Sheet export and Google Drive import use these settings."
- "https://www.googleapis.com/auth/drive.file"
- "Enable the Google Drive API, the Google Sheets API, and the Google Picker API in the service-account project."
- "Create an API key. Restrict it to the Google Picker API."
- "Add no website restriction to the key. Campus Commander sends no referrer, so a website restriction blocks the Picker."
- "Copy the project number from the project dashboard. The key file holds only the project ID."
- "Add the Drive scope to domain-wide delegation, then check Google access."

### State 15, google-connection-drive-saved

- "Google Drive is ready for Google Sheet export and Google Drive import."

### State 16, diagnostics-drive-check

- "Google Drive files"
- "Recheck Google Drive files"
- "Google Drive files setup details"
- "Enable the Admin SDK API, the Google Drive API, the Google Sheets API, and the Google Picker API in the service-account project."
- "https://www.googleapis.com/auth/admin.directory.customer.readonly, https://www.googleapis.com/auth/admin.directory.device.chromeos, https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly, https://www.googleapis.com/auth/admin.directory.domain.readonly, https://www.googleapis.com/auth/admin.directory.orgunit.readonly, https://www.googleapis.com/auth/chrome.management.telemetry.readonly, https://www.googleapis.com/auth/drive.file"

### App literals with a new meaning

- "Devices" · state 07, app literal in `devices.html` with another meaning

## Google Picker strings

21 strings of state 06. The Picker is the frame of Google.
Campus Commander neither ships nor styles these words. The mockup draws them as a neutral sample.

- "Select a file"
- "Search in Drive"
- "My Drive"
- "Name"
- "Owner"
- "Last modified"
- "devices-for-editing-EXP-003"
- "me"
- "11:02 AM"
- "devices-for-editing-EXP-001.csv"
- "Oct 29"
- "library-reset"
- "Oct 26"
- "loaner-carts.csv"
- "Oct 21"
- "Room 12 inventory"
- "Oct 14"
- "Cancel"
- "Select"
- "Close"
- "Files"

## Mockup annotations

1 string. It explains the sample of state 06 and is not app text.

- "Google Picker: the frame of Google, drawn here as a neutral sample. Campus Commander does not style it."
