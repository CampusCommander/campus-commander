# Users slice mockup: notes

Proposal mockup of slice S1 (browse users) and the value part of slice S3 (set attribute values), Figma-ready.
Files: `users-mockup.html`, `png/`, `snapshots/`, `render-report.json`, `check-strings.py`, `build.py`, `render.cjs`, `work/cal/`, `work/skill-lessons.md`.
Every element is drawn with HTML and CSS. No state holds a screenshot, an image element, or a CSS background image (`work/snapcheck/result.json` proves it per snapshot).

## Approval and build rulings

On 2026-11-16 the owner answered questions U1 to U7 in the main chat: "All recommended". The screens draw option 1 of each question.
Later that day he approved the screens of Figma page 11, with four named defaults. Owner: "1) Approved".
The [record](../../workflows/user-management.md) holds the decisions and the defaults.

Stored files: `2026-11-16-user-management.html` is `users-mockup.html` below. `2026-11-16-user-management-NN-<state>.png` is `png/NN-<state>.png`.
The snapshots, the scripts, and the `work/` folder stay outside the repository.

Rulings on "Questions that the screens expose":

| Question | Ruling |
| --- | --- |
| 1 | U5 option 1. State 08 offers every attribute. |
| 2 | Accepted default 4 of the record. The Name column stays pinned. |
| 3 | Build deviation. The Users grid keeps the font of the built Devices grid. The mockup draws Roboto. |
| 4 | Document B, default E10. The edit form and the bulk dialog show the count message of in-grid editing. |
| 5 | Document B, default E11. The value checks refuse a value outside the range of the attribute. |
| 6 | The value screens show no account limit. |
| 7, 8, 10 | Drafted strings. The owner approves them in the sign-off wording list. |
| 9 | Slices S4 and S5 add the other Bulk Actions entries, each with its own screens. |
| 11, 12 | Inherited from the built app. The build keeps the built behavior. |
| 13 | The build uses the Material chip component. The CSS copy is mockup only. |
| 14 | Tooling note. It changes no build. |

## Owner direction

- The owner asked for user management with the look and feel of device management, and for a unique flow for custom attributes (baseline section 1, verbatim there).
- The screens follow the recommended answer of each question U1 to U5.
- The owner labels and the baseline vocabulary win: Category, Attribute, Info type, Value, Multiple values, Set attributes.
- Instructions stay out of the flow. The dialog title row holds a help icon button. The flow shows state messages only: counts, the error, the failure, and the job.
- The flow ends where it starts: Set attributes shows setup, review, and results in one dialog. The job ID is a secondary link.
- The setup steps keep the built 480 px dialog width. The review and the results widen to the 1120 px wide modal.
- The shell shows `example.org`, `example.org`, and `C0123456`. The review build banner stays as the app shows it ("Development review. ...").
- A dashed pill in the top bar reads "Proposal mockup, not the built app" with the state name. It opens the state list. It is mockup annotation, not app UI, and the string checks skip it.

## States

| PNG | State | Capture |
| --- | --- | --- |
| `png/01-users-grid.png` | Users grid, no selection, no filter, 2,418 matching users | full page 1440 x 1310 |
| `png/02-columns-panel.png` | Columns panel open, Grade level and Programs shown | full page 1440 x 1310 |
| `png/03-attribute-filter.png` | Filter editor of Grade level, 9 to 12, 612 matching users | full page 1440 x 1310 |
| `png/04-user-details.png` | User details of Amara Okafor | full page 1440 x 1040 |
| `png/05-user-details-edit.png` | Custom attributes card in edit mode, Grade level error | full page 1440 x 1389 |
| `png/06-in-grid-pending.png` | Two draft cells and the pending changes bar | full page 1440 x 1320 |
| `png/07-bulk-actions-menu.png` | 25 selected, Bulk Actions open with Set attributes | full page 1440 x 1252 |
| `png/08-set-attributes-dialog.png` | Set attributes setup, Programs, Add values, ESL | viewport 1440 x 900 |
| `png/09-set-attributes-review.png` | Review in the wide modal, 25 = 7 + 18 | viewport 1440 x 900 |
| `png/10-set-attributes-results.png` | Results of UAT-014, 17 succeeded and 1 failed | viewport 1440 x 900 |
| `png/11-set-attributes-single-value.png` | Setup for Homeroom, Set value 216 | viewport 1440 x 900 |
| `png/12-details-saved.png` | User details after the save of Grade level 11 | full page 1440 x 1072 |
| `png/13-no-matches.png` | Filter Homeroom is 999, no matching user | full page 1440 x 1269 |

- A page taller than the viewport is a full-page capture. The four dialog states are viewport captures with the page, the scrim, and the dialog.
- Deep links `#01-users-grid` to `#13-no-matches` work on a fresh load and on a hash change (`render-report.json`, checks).
- The HTML exposes `window.mockup = { STATES, show }`. After `show(name)`, only that state is in the DOM.
- Snapshots: `snapshots/users-index.json` lists 13 files. Each snapshot renders alone with a mean difference of 0.0 against its PNG, and each is under 400 KB.

## Scenario and data

- Sunday, November 1, 2026, 9:30 AM Eastern. The person is Review administrator.
- The district holds 2,418 users: 2,104 under `/Students`, 286 under `/Staff`, 28 under `/Admin`.
- Categories (baseline default 13): Student information (Student ID, Grade level, Graduation year, Homeroom, Programs with multiple values), Staff information (Employee ID, Building, Hire date, Certifications with multiple values), Device program (Take-home approved).
- State 01 lists the first 14 users of the district by name. They come from `/Students/High School`, `/Students/Middle School`, and `/Staff/High School`. Adam Novak is Suspended. 2-step verification is mixed.
- State 03 lists the first 14 users with Grade level 9 to 12 (612 users).
- States 07 to 11 filter Grade 10 under `/Students/High School` (164 users). The person selected 25 users. Amara Okafor is not selected, so her Programs stay Gifted and Band in states 04, 05, and 12.
- Set attributes adds ESL to Programs. 7 of the 25 users hold ESL already (No change needed). 18 are Proposed. Job UAT-014 sets 17 values. Google refuses Darius Grant: "Google could not find this user."
- State 12 follows job UAT-015: one change, Grade level 10 to 11, saved from the details page.
- The counts add up in code: the HTML throws on load when 25, 18, or 7 drift.

## Fidelity and calibration

- The shell copies `shell.html` and `shell.css`, the Users page copies `devices.html` and `devices.css`, and the details page copies `device-detail.html` and `device-detail.css` of origin/main 7e7e81e.
- Material parts use the CSS that Angular Material 22.2.2 ships (`work/material/extract.py`) and the compiled app theme (`work/theme/`).
- The grid redraws the built LibreGrid (AG Grid quartz) geometry: 48 px header with a 1 px rule, 42 px rows, 16 px cell padding, the pinned checkbox and details columns (105 px), the 16 px scroll gutter, the 32 px side bar, the status bar, and the paging panel.
- Icons are inline SVG paths of the bundled Material Symbols Outlined font, weight 400 (`work/icons.py`, viewBox `0 -960 960 960`). Text is real text in Roboto from `@fontsource/roboto`, embedded as base64. Serials and IDs use Roboto Mono.
- Calibration (`work/cal/`): `cal.cjs` draws the real Devices screen with the mockup parts and the Devices data. `cal.py` diffs it against `ref/devices-ready.png`. The navigation identity lines stay out of every region, because the screenshot shows a real tenant.
- Results (`work/cal/cal-results.json`, mean per pixel and channel, 0-255): notice 0.000, page header 0.000, hint band 0.000, status bar 0.000, toolbar 0.092, top bar 0.170, navigation heading 0.027. Without the icon boxes: navigation 0.000, top bar 0.000, grid header 0.025, grid rows 0.086.
- With the icon boxes: navigation 0.212, grid header 0.347, grid rows 0.313. The built app draws icons with the font and the built grid draws the AG Grid quartz icon set. The mockup draws every icon as a Material Symbols SVG path (Figma-ready rule). The residual difference sits in those glyphs only.
- The built grid uses the quartz font stack. On the review host that stack resolves to Segoe UI from the Windows fonts, not to Roboto. The calibration run sets that stack on the grid to prove the geometry. The deliverable draws the grid in the embedded Roboto, the app font that Figma holds. Grid text is therefore narrower in the PNGs than in the review screenshots.
- The grid region shows 14 rows. The built rule `max(420px, 100vh - 360px)` gives 540 px at 900 px. The full-page captures grow the region, so the Columns panel fits whole.

## Composition choices

1. Multi-value cell (state 02): a comma list, "Gifted, Band", one line with an ellipsis when it does not fit. The review and the results use the same comma list. The details page shows the values as static chips.
2. Empty category on the details page (state 04): the section heading with one line, "No values set". Edit mode (state 05) shows the editors of that category.
3. Attribute column header (states 02 and 06): the attribute name only. The Columns panel groups the attributes under their category. When two categories hold the same attribute name, the header adds the category after a middle dot (a rule, no state shows it).
4. Edit control (states 04 and 05): one outlined Edit button at the right of the Custom attributes card heading. The whole card edits at once, with one Cancel and one Save changes. Category sections do not edit alone, so one save makes one job.
5. Value control of the bulk dialog (states 08 and 11): Text with multiple values takes a chip input. Text with one value takes a text field. Whole number and Decimal number take a text field with number validation. Yes or no takes a button toggle Yes and No. Date takes a date field. Email and Phone take a text field. The modes show as two-column option cards. The hint under Attribute names the info type and the number of values.
6. The Name column stays pinned at the left with the checkbox and details columns. A grid scrolled to the attribute columns keeps each user in view (states 02, 03, 06).
7. The grid region shows 14 rows in the full-page captures (Fidelity and calibration).
8. The number filter editor (state 03) keeps the built filter editor card and shows From and To on one line. The chip reads "Grade level 9 to 12". A one-value range reads "Grade level 10" (state 07).
9. The tab bar (Users, Custom attributes) sits between the page header and the filter row, 48 px tabs, under the answer U2-1.
10. The Account and Organization cards show read-only facts as a label over a value without an outline. The custom attribute values keep the outlined boxes of the device annotations, the writable fields of device details.
11. The review and the results share one table: User, Primary email, Current value, New value, and Outcome in the results. Ten rows a page. The leading columns keep their widths in both. The review has the views Proposed and No change needed. The results have All and Failed.
12. The jobs band of the results holds one row: UAT-014 as a secondary link, the action, the status chip, and the counts.
13. The saved line of state 12 sits at the top of the Custom attributes card: a success icon and "Grade level saved to Google · Job UAT-015" with the job ID as a secondary link.
14. The pending changes bar reads "2 pending changes · 2 users", the built count line with the noun users. Its actions are the built Show pending changes, Revert all changes, and Save changes.

## Questions that the screens expose

1. Product question, owner: question U5. The Attribute select of state 08 offers every attribute, also Student ID. Answer U5-2 adds a mark in the category editor and hides marked attributes in state 08.
2. Product question, owner: the Name column pin (choice 6) is new. The Devices grid pins no data column.
3. Product question, owner: the built grid draws its text in the quartz font stack (Segoe UI on Windows hosts), not in the app font Roboto. The Users grid can set the grid font to the app font. The mockup draws Roboto.
4. Per-field limit: a single Text value holds up to 500 characters (Google). The edit form and the bulk dialog need the count message of in-grid editing ("512 of 500 characters").
5. Per-field limit: the Grade level range 0 to 12 is indicative only in Google (`numericIndexingSpec`). The mockup validates the whole number only. Decide whether the app refuses 13.
6. Per-field limit: Google accepts at most 100 custom fields and 100 categories for each account. The value screens show no limit.
7. The failure text "Google could not find this user." is drafted. The worker must map the Google 404 of `users.update` to it, and the mock release 0.4.0 must return that 404.
8. The chip text of a number filter is drafted. The built chips use "Label · values" for sets and "Label operator: value" for text.
9. Bulk Actions holds Set attributes only (state 07). Slice S4 adds Suspend, Reactivate, Move to OU, Sign out, and Require password change. Slice S5 adds Export and Import.
10. The status bar freshness line "Directory observed" is drafted. The user cache of slice S1 must expose its observation time.
11. Defect inherited from the reference build: the drawn dark page of csv-slice-mockup-v4 colors the top bar icon buttons with the primary text color. The app uses the on-surface-variant color (calibration found it).
12. Defect inherited from the built app: the dialog scrim starts below the top bar (`device-dialog.css`), so the top bar and the wordmark stay undimmed in states 08 to 11.
13. The Material chip DOM of `chips.mjs` did not lay out in the static markup. The chips of states 05 and 08 copy the M3 input chip metrics in plain CSS (32 px, 8 px radius, outline variant border, 18 px remove icon).
14. Tooling: one ad hoc scan command timed out at the approval step. `check-strings.py` runs the same forbidden-term scan as a deliverable script.

## Map of baseline defaults and owner questions

| Item | States | Note |
| --- | --- | --- |
| Default 1, Users nav item below Devices | every state | The nav shows Users selected. |
| Default 2, default and optional columns | 01, 02 | The Columns panel lists Created, Department, Title, and each attribute. |
| Default 3, status values | 01, 04 | Active and Suspended show. Archived shows in no row. |
| Default 4, typed filters | 03, 07, 13 | Number range, org unit set, text operator. |
| Default 5, details layout | 04, 05, 12 | Account, Organization, Custom attributes, Not set, chips. |
| Default 6, every write is a job | 10, 12 | UAT-014 and UAT-015 as secondary links. |
| Default 7, visibility and searchable | none | The Custom attributes tab of builder B. |
| Default 8, locked controls | none | Builder B. |
| Default 9, typed phrase on delete | none | Builder B. |
| Default 10, account limits as counts | none | Builder B. Question 6 above. |
| Default 11, bulk modes and review | 08, 09, 10, 11 | Multi-value and single-value modes, review, results. One pending in-grid change saves at once (12). |
| Default 12, job prefix UAT- | 10, 12 | Drafted prefix. |
| Default 13, scenario data | every state | Categories, attributes, and counts. |
| U1, assign means set values | 04 to 12 | Answer U1-2 adds an org unit link per category and hides columns and editors outside it (02, 04, 05, 08). |
| U2, Custom attributes tab | every Users page state | Answer U2-2 removes the tab bar from every state. |
| U3, build order | none | The order changes no screen. |
| U4, who sees definitions | none | Builder B. Answer U4-2 hides the Custom attributes tab for a person without User Schema Manage. |
| U5, bulk on identifiers | 08 | Answer U5-2 removes marked attributes from the Attribute select. |

## Strings

- App-sourced: whole literals or element texts of origin/main, plus composed app texts and app templates with data.
- Built grid packages: literals of LibreGrid 1.3.5 and AG Grid 36.2.0 from the app lockfile, with counts as data.
- Mockup data: names, emails, org unit paths, times, counts, values, and the scenario names of categories and attributes.
- Drafted: every other visible string. The owner approves them. `check-strings.py` writes the four lists below and fails when this file misses a visible string or lists a stale one.
- New uses of app literals: Edit opens the card form (the app uses it elsewhere), Review starts the review step, and Value labels the single-value field.

## App-sourced strings

The lists App source and Built grid packages below.

## Mockup data

The list Mockup data list below.

## Drafted strings

The list Drafted list below.

<!-- strings:begin (written by check-strings.py) -->
### App source (52)

Whole literals or element texts of origin/main 7e7e81e.

- `+` (09, 10)
- `=` (09, 10)
- `Active` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Add a filter` (01, 02, 06, 07, 08, 09, 10, 11, 13)
- `Apply` (03)
- `Bulk Actions` (01, 02, 03, 06, 07, 08, 09, 10, 11, 13)
- `Campus Commander` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Cancel` (03, 05, 08, 11)
- `changes` (10)
- `Clear filters` (01, 02, 03, 06, 07, 08, 09, 10, 11, 13)
- `Clear value` (11)
- `Columns` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Completed with errors` (10)
- `Created` (02, 04, 05, 12)
- `Current value` (09, 10)
- `Customer settings` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Development review. Google sign-in and Workspace data are simulated. Use the sample service-account file. Do not upload real credentials.` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Devices` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Diagnostics` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Done` (10)
- `Edit` (04, 12)
- `Failed` (10)
- `From` (03)
- `Google connection` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Google results are out of date` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Homeroom is: 999` (13)
- `Jobs` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Name` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `New value` (09, 10)
- `No change needed` (09)
- `Not set` (04, 05, 09, 10, 12)
- `Organization unit` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Organization unit · /Students/High School` (07, 08, 09, 10, 11)
- `Outcome` (10)
- `Platform access` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Platform invitations` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Proposed` (09)
- `Refresh` (01, 02, 03, 06, 07, 08, 09, 10, 11, 13)
- `Revert all changes` (06)
- `Review` (08, 11)
- `Save changes` (05, 06)
- `Schools` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Services ready` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Show pending changes` (06)
- `Status` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Succeeded` (10)
- `Title` (02, 04, 05, 12)
- `To` (03)
- `Value` (11)
- `Version development · Build client-review` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Your account` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `·` (10)

### Built grid packages (20)

Literals of LibreGrid 1.3.5 and AG Grid 36.2.0 in the app lockfile, with data in the count.

- `1 to 100 of 164` (07, 08, 09, 10, 11)
- `1 to 100 of 2,418` (01, 02, 06)
- `1 to 100 of 612` (03)
- `Deselect All` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Filters` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `of 2` (07, 08, 09, 10, 11)
- `of 25` (01, 02, 06)
- `of 7` (03)
- `Page` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Page Size:` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Search...` (02)
- `Select All (164)` (07, 08, 09, 10, 11)
- `Select All (2418)` (01, 02, 06)
- `Select All (612)` (03)
- `Selected on current page: 0` (01, 02, 03, 06)
- `Selected on current page: 25` (07, 08, 09, 10, 11)
- `Show All Selected (0)` (01, 02, 03, 06)
- `Show All Selected (25)` (07, 08, 09, 10, 11)
- `Total Selected: 0` (01, 02, 03, 06)
- `Total Selected: 25` (07, 08, 09, 10, 11)

### Mockup data list (144)

- `/Staff/High School` (01, 02, 06)
- `/Students/High School` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `/Students/Middle School` (01, 02, 06)
- `1` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `10` (02, 03, 04, 06)
- `100` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `105` (06)
- `11` (02, 03, 06, 12)
- `118` (06)
- `12` (02, 03, 06)
- `17` (10)
- `18` (09, 10)
- `2029` (04, 05, 12)
- `204518` (04, 05, 12)
- `214` (04, 05, 06, 12)
- `216` (06, 11)
- `230` (06)
- `25` (09)
- `6` (02, 06)
- `7` (02, 06, 09)
- `8` (02, 06)
- `9` (02, 03, 06)
- `Aaliyah Brooks` (01, 02, 03, 06)
- `aaliyah.brooks@example.org` (01, 02, 03, 06)
- `Aaron Whitfield` (01, 02, 06)
- `aaron.whitfield@example.org` (01, 02, 06)
- `Abdul Karim` (01, 02, 06)
- `abdul.karim@example.org` (01, 02, 06)
- `Abigail Chen` (01, 02, 03, 06)
- `abigail.chen@example.org` (01, 02, 03, 06)
- `Adam Novak` (01, 02, 06)
- `adam.novak@example.org` (01, 02, 06)
- `Adriana Flores` (01, 02, 03, 06)
- `adriana.flores@example.org` (01, 02, 03, 06)
- `Ahmed Hassan` (01, 02, 06)
- `ahmed.hassan@example.org` (01, 02, 06)
- `Aiden Murphy` (01, 02, 06)
- `aiden.murphy@example.org` (01, 02, 06)
- `Aisha Rahman` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `aisha.rahman@example.org` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Alan Brennan` (01, 02, 06)
- `alan.brennan@example.org` (01, 02, 06)
- `Alejandro Ruiz` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `alejandro.ruiz@example.org` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Alice Thornton` (01, 02, 06)
- `alice.thornton@example.org` (01, 02, 06)
- `Amara Okafor` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `amara.okafor@example.org` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Ana Sofia Reyes` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `anasofia.reyes@example.org` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Andre Silva` (03)
- `andre.silva@example.org` (03)
- `Anika Shah` (03)
- `anika.shah@example.org` (03)
- `Antonio Bianchi` (03)
- `antonio.bianchi@example.org` (03)
- `Arjun Mehta` (03)
- `arjun.mehta@example.org` (03)
- `Aug 14, 2023` (04, 05, 12)
- `Ava Lindqvist` (03, 07, 08, 09, 10, 11)
- `ava.lindqvist@example.org` (03, 07, 08, 09, 10, 11)
- `Band` (02, 03, 04, 05, 09, 10, 12)
- `Band, ESL` (09, 10)
- `Benjamin Osei` (03, 07, 08, 09, 10, 11)
- `benjamin.osei@example.org` (03, 07, 08, 09, 10, 11)
- `Bianca Rossi` (03)
- `bianca.rossi@example.org` (03)
- `Brianna Walsh` (07, 08, 09, 10, 11)
- `brianna.walsh@example.org` (07, 08, 09, 10, 11)
- `Building` (02, 05)
- `C0123456` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Caleb Nguyen` (07, 08, 09, 10, 11)
- `caleb.nguyen@example.org` (07, 08, 09, 10, 11)
- `Camila Duarte` (07, 08, 09, 10, 11)
- `camila.duarte@example.org` (07, 08, 09, 10, 11)
- `Certifications` (02, 05)
- `Chloe Bennett` (07, 08, 09, 10, 11)
- `chloe.bennett@example.org` (07, 08, 09, 10, 11)
- `Daniel Kowalski` (07, 08, 09, 10, 11)
- `daniel.kowalski@example.org` (07, 08, 09, 10, 11)
- `Darius Grant` (07, 08, 09, 10, 11)
- `darius.grant@example.org` (07, 08, 09, 10, 11)
- `Device program` (02, 04, 05, 12)
- `Elena Marquez` (07, 08, 09, 10, 11)
- `elena.marquez@example.org` (07, 08, 09, 10, 11)
- `Employee ID` (02, 05)
- `ESL` (02, 03, 08, 09, 10)
- `ESL, Robotics` (02, 03)
- `Ethan Cho` (07, 08, 09, 10, 11)
- `ethan.cho@example.org` (07, 08, 09, 10, 11)
- `example.org` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Gabriel Santos` (09, 10)
- `gabriel.santos@example.org` (09, 10)
- `Gifted` (02, 03, 04, 05, 09, 10, 12)
- `Gifted, Band` (02, 03, 09, 10)
- `Gifted, Band, ESL` (09, 10)
- `Gifted, ESL` (09, 10)
- `Gifted, Robotics` (03)
- `Grade level` (02, 03, 04, 05, 06, 12)
- `Graduation year` (02, 04, 05, 12)
- `Hire date` (02, 05)
- `Homeroom` (02, 04, 05, 06, 11, 12)
- `M04` (06)
- `M12` (06)
- `M21` (06)
- `Nov 1, 7:58 AM` (01, 02, 06)
- `Nov 1, 8:51 AM` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Oct 27, 3:30 PM` (07, 08, 09, 10, 11)
- `Oct 28, 11:03 AM` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Oct 28, 7:40 PM` (03)
- `Oct 29, 10:22 AM` (01, 02, 06)
- `Oct 29, 7:16 PM` (07, 08, 09, 10, 11)
- `Oct 29, 8:47 PM` (03)
- `Oct 30, 10:41 AM` (07, 08, 09, 10, 11)
- `Oct 30, 1:47 PM` (01, 02, 03, 06)
- `Oct 30, 3:05 PM` (01, 02, 06)
- `Oct 30, 4:21 PM` (07, 08, 09, 10, 11)
- `Oct 30, 6:02 PM` (03)
- `Oct 30, 8:15 AM` (01, 02, 06)
- `Oct 30, 9:18 PM` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Oct 31, 10:14 AM` (03)
- `Oct 31, 11:48 AM` (07, 08, 09, 10, 11)
- `Oct 31, 1:09 PM` (07, 08, 09, 10, 11)
- `Oct 31, 2:55 PM` (03, 07, 08, 09, 10, 11)
- `Oct 31, 3:42 PM` (01, 02, 03, 06)
- `Oct 31, 4:30 PM` (01, 02, 06)
- `Oct 31, 5:26 PM` (03)
- `Oct 31, 6:12 PM` (07, 08, 09, 10, 11)
- `Oct 31, 6:40 PM` (01, 02, 06)
- `Oct 31, 7:12 PM` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Oct 31, 8:33 PM` (03, 07, 08, 09, 10, 11)
- `Oct 31, 9:05 PM` (01, 02, 03, 06)
- `Oct 31, 9:57 AM` (07, 08, 09, 10, 11)
- `Programs` (02, 03, 04, 05, 08, 12)
- `Review administrator` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Robotics` (03, 09, 10)
- `Robotics, ESL` (09, 10)
- `Sep 12, 2:10 PM` (01, 02, 06)
- `Staff information` (02, 04, 05, 12)
- `Student ID` (02, 04, 05, 12)
- `Student information` (02, 04, 05, 08, 11, 12)
- `Take-home approved` (02, 04, 05, 12)
- `ten` (05)
- `UAT-014` (10)

### Drafted list (57)

The owner approves these strings.

- `1 failed` (10)
- `164 matching users · 2,418 in district` (07, 08, 09, 10, 11)
- `17 succeeded` (10)
- `1–10 of 18 changes` (10)
- `1–10 of 18 proposed changes` (09)
- `2 pending changes · 2 users` (06)
- `2,418 matching users · 2,418 in district` (01, 02, 06)
- `2-step verification` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `25 selected users` (08, 11)
- `25 selected users · Student information · Programs` (09)
- `612 matching users · 2,418 in district` (03)
- `Account` (04, 05, 12)
- `Add values` (08)
- `All` (10)
- `Attribute` (08, 11)
- `Back` (09)
- `Back to users` (04, 05, 12)
- `Category` (08, 11)
- `Check the name or email, or clear the current filters.` (13)
- `Clear values` (08)
- `Custom attributes` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Department` (02, 04, 05, 12)
- `Directory observed Nov 1, 9:12 AM` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Enrolled` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Enter a whole number.` (05)
- `Executed by Review administrator · Nov 1, 9:41 AM` (10)
- `Finished Nov 1, 9:41 AM` (10)
- `Google could not find this user.` (10)
- `Google Workspace accounts` (01, 02, 03, 06, 07, 08, 09, 10, 11, 13)
- `Grade level 10` (07, 08, 09, 10, 11)
- `Grade level 9 to 12` (03)
- `Grade level saved to Google · Job UAT-015` (12)
- `Job UAT-014 · Completed with errors` (10)
- `Last sign-in` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Mode` (08, 11)
- `Next user` (04, 05, 12)
- `No` (05)
- `No users match these filters` (13)
- `No values set` (04, 12)
- `Not enrolled` (01, 02, 03, 06, 07, 08, 09, 10, 11)
- `Organization` (04, 05, 12)
- `Primary email` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- `Programs · Add values · ESL` (09)
- `Remove values` (08)
- `Replace all values` (08)
- `Select one or more users to set attributes.` (01, 02, 03, 13)
- `Set attributes` (07, 08, 09, 10, 11)
- `Set attributes on 18 users` (09)
- `Set value` (11)
- `Suspended` (01, 02, 06)
- `Text · Multiple values` (08)
- `Text · Single value` (11)
- `User` (09, 10)
- `User details · /Students/High School` (04, 05, 12)
- `Users` (01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13)
- `Values` (08)
- `Yes` (04, 05, 12)
<!-- strings:end -->
