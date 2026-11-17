# Custom attributes slice: proposal mockup notes (Figma-ready)

Builder B of the Users and Custom attributes pair. Briefs: `user-management/briefs/mockup-shared.md` and `user-management/briefs/mockup-b-custom-attributes.md`. Baseline: `user-management/baseline.md`.
The mockup is `custom-attributes-mockup.html`. The PNGs are in `png/`. The state snapshots for the Figma import are in `snapshots/` with the index `snapshots/attrs-index.json`.

## Approval and build rulings

On 2026-11-16 the owner answered questions U1 to U7 in the main chat: "All recommended". The screens draw option 1 of each question.
Later that day he approved the screens of Figma page 12, with four named defaults. Owner: "1) Approved".
The [record](../../workflows/user-management.md) holds the decisions and the defaults.

Stored files: `2026-11-16-custom-attributes.html` is `custom-attributes-mockup.html` below. `2026-11-16-custom-attributes-NN-<state>.png` is `png/NN-<state>.png`.
The briefs, the baseline path, the snapshots, the scripts, and the `work/` folder below stay outside the repository. The stored baseline is [user-management-planning-baseline.md](../../research/user-management-planning-baseline.md).

Rulings on "Questions that the screens expose":

| Question | Ruling |
| --- | --- |
| 1 | Accepted default 2 of the record. Build deviation: the category list drops the Last changed column of state 01. |
| 2 | Accepted default 3 of the record. The design adds an optional range for number attributes. No frame draws the range inputs. That card waits for a frame that the owner approves. |
| 3 | Document B section 9. The category job removes the deleted key from every cached user. |
| 4 | State 10 as approved. The editor opens and shows the limit. |
| 5 | Open. The design addendum decides whether display names must be unique inside a category. |
| 6 | Owner UI rule. The help docs carry the sensitive data warning. The flow shows none. |
| 7 | Open. The design addendum confirms the navigation of a person with User Read only from the built capability rules. |

The typed confirmation is the attribute name or the category display name, as states 05 and 08 draw it (accepted default 1).
The words "deletes its values" stay in the build only after check L3 of document B confirms them (U7). A different result changes the text, and the owner approves the new text.

## Owner direction

The owner wrote on 2026-11-01: "This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it."
This slice draws the first half: creating and managing the categories (baseline slice S2).

The screens apply the owner UI rules of the shared brief:

- Instructions sit behind the info icon button of the toolbar and of each dialog title row. The flow holds only state messages: errors, limits, counts, and the 24-hour visibility delay.
- The category flow starts and ends in one dialog. The editor, the review, the progress, and the result share it. The job ID `CAT-003` shows as a secondary link in the sub line.
- The result reuses the review table with an Outcome column. A Failed view with its count stays one click away.
- The saving step shows only the phases and the count at the built 480 px width. The dialog is wide (1120 px) only for the steps with a table.
- The shell shows `example.org`, `example.org`, and `C0123456`.

The shell keeps the review build banner as the app shows it ("Development review. ..."). The footer copies the review build footer strip: the version line, `Services ready`, and `Google results are out of date`.
The baseline labels win over the Figma Users frames of page 240:2. The mockup copies no shell from those frames.

## States

All 12 states are viewport captures at 1440 x 900. No page is taller than the viewport, so no state needs a full-page capture.

| # | State | Content |
| --- | --- | --- |
| 01 | `categories-list` | The Custom attributes tab with three categories, the limits line, and Create category. |
| 02 | `create-category` | The editor dialog for the new category Transportation with three attributes. |
| 03 | `create-errors` | State 02 with three in-flow errors and the review action disabled. |
| 04 | `edit-category` | The editor for Student information with locked properties, the new Counselor row, and Homeroom marked for removal. |
| 05 | `review-changes` | The review step: two changes, the domain-wide line, and the typed phrase gate with the save action disabled. |
| 06 | `saving` | The running job `CAT-003` at the built 480 px width, with the bell badge of the running job. |
| 07 | `saved` | The result table with the Outcome column, the Failed view, and Close. |
| 08 | `delete-category` | The delete question for Device program, phrase typed, the filled error action enabled. |
| 09 | `read-only` | A person with User Read and without User Schema Manage opens Student information. |
| 10 | `limit-reached` | The editor while the account holds 100 of 100 attributes. |
| 11 | `empty` | No category exists yet. |
| 12 | `visibility-change` | The editor for Staff information after Building changes to Admins and the user. |

Deep links `#01-categories-list` to `#12-visibility-change` work on a fresh load and on a hash change (render.cjs tests both).
The state switcher sits in a shadow root at the bottom left. A snapshot clones the page without shadow roots, and the PNG run hides it, so no capture shows it.

## Scenario and data

- Sunday, November 1, 2026, 9:30 AM Eastern. The person is Review administrator. State 09 shows a second person, Review recipient, because a person without User Schema Manage is another account.
- Categories (baseline section 7, item 13): Student information (`StudentInfo`, 5 attributes, 2,104 users with values), Staff information (`StaffInfo`, 4 attributes, 286 users), Device program (`DeviceProgram`, 1 attribute, 1,312 users). That is 3 of 100 categories and 10 of 100 attributes. The template asserts the 10 on load.
- Attribute names are drafted from the display names: `StudentId`, `GradeLevel`, `GraduationYear`, `Homeroom`, `Programs`, `EmployeeId`, `Building`, `HireDate`, `Certifications`, `TakeHomeApproved`.
- Every attribute is Searchable. Every attribute has Visibility Admins and the user, except Building (Everyone in the organization). Homeroom holds values on 1,988 users.
- The table sorts by Category, so Device program comes first.
- Last changed: Device program Oct 19, 2026, Student information Sep 8, 2026, Staff information Not recorded (question 1 below).
- State 02 counts 13 of 100 attributes after the change (10 plus 3). State 03 counts 14, because it holds a fourth row (the second Rider). State 04 counts 10 (one added, one removed).
- State 10 changes only the account count to 100 of 100 attributes. The page under the scrim keeps the scenario rows, and the dialog covers them.
- The job of the edit is `CAT-003` (baseline default 12, drafted prefix). It finishes Nov 1, 9:31 AM.

## Fidelity and calibration

Every element is HTML and CSS: the shell, the banner, the tab bar, the table, the fields, the chips, and the dialogs. No state uses a screenshot or an image. render.cjs counts 0 `img`, 0 `canvas`, and 0 elements with a background image in every state.

- CSS: shell.css, devices.css, device-dialog.css, device-export-import-dialog.css, device-import-dialog.css, job-activity.css, the grid theme of device-grid.ts, styles.scss, and tokens.css of main 7e7e81e. The Material theme compiles from `work/theme/theme.scss` with the repository sass. `work/material/extract.py` copies the Angular Material 22.2.2 component CSS.
- Fonts: Roboto 400, 500, 700 and Roboto Mono 400 of @fontsource, embedded as base64. Identifiers (category names and attribute names) use the app monospace stack.
- Icons: `work/icons.py` reads the bundled Material Symbols Outlined font (weight 400) and writes each glyph outline as an SVG path in the viewBox `0 -960 960 960`.

Calibration (`work/cal/`): `cal.cjs` injects three cases from the harness, so the deliverable holds no calibration string. `cal.py` diffs them against the screenshots in `ref/`.

| Region | Screenshot | Mean without icons | Mean in icon boxes | Mean of the region |
| --- | --- | --- | --- | --- |
| Navigation heading | start-05b-devices-ready | 0.000 | 0.731 | 0.026 |
| Navigation items | start-05b-devices-ready | 0.000 | 6.558 | 0.371 |
| Top bar | start-05b-devices-ready | 0.000 | 5.914 | 0.196 |
| Banner | start-05b-devices-ready | 0.000 | none | 0.000 |
| Page title and subtitle | start-05b-devices-ready | 0.000 | none | 0.000 |
| Toolbar buttons | start-05b-devices-ready | 0.000 | 0.491 | 0.041 |
| Dialog head | 04-export-running | 0.000 | 1.776 | 0.078 |
| Dialog phases | 04-export-running | 0.000 | none | 0.000 |
| Dialog action bar | 04-export-running | 0.000 | 3.305 | 0.040 |
| Wide dialog head | 13-review-proposed | 0.000 | 1.844 | 0.029 |

- Text, boxes, borders, buttons, and the phase list re-create the screenshots at 0.000.
- Icons differ at their edges only. The probes place every icon at the same pixel as the font glyph (the best shift is 0), but the font raster of Chromium carries about 3 percent more ink than the SVG raster of the same outline. A hairline stroke made the difference larger (`work/cal/icon-stroke.cjs`). The Figma rule requires SVG icons, so the icon boxes stay above 0.2. The navigation region reaches 0.371 for that reason only.
- The 15.75 px icon of a Material button draws 1 px above its box as a font glyph. The mockup moves the SVG up by 1 px (`work/cal/account-icon.cjs`).
- The footer strip (from a job page capture of the CSV build) sits 1 px higher than the mockup footer. A 1 px shift gives 0.006. The source page had a fractional height.
- The identity lines are masked: the screenshot shows the tenant, the mockup shows `example.org` and `C0123456`.

Checks of render.cjs in every state: no request, page error, or console error, no word broken over two lines except the app break of service-account in the banner (the screenshot breaks it the same way), no clipped text, no element outside the dialog, nothing past 1,440 px, and no scrolling dialog body.
Snapshot check (`work/snapshot-check.cjs`): each of the 12 snapshots renders alone and equals its PNG pixel for pixel. Each holds no script and no image, and each stays under 320 KB.

## Composition choices (numbered)

1. Attribute editing: the attributes are rows of one table, edited in place. A Google field has six properties, so one row holds all of them, and the person sees every attribute and the limit at once. No row opens a detail panel.
2. A locked property shows as plain text with a lock glyph and the state line `Fixed at creation` under it. A disabled field reads as a control that waits for input. A checked multiple-values box stays a disabled checkbox with the lock and `Cannot return to one value`, so the column keeps one look.
3. The Category name field sits beside Display name. It fills from the display name (spaces dropped, letters, digits, _ and - kept) until the person edits it. The hint `Locks after the first save` states the limit. From the first save on, the name shows as locked plain text (state 04). Each attribute name derives from its display name the same way (`BusRoute`).
4. The review step is one table with one row per change: Change (chip), Attribute, and Effect. The domain-wide line sits above the table. A removal adds the one-way note and the typed phrase under the table. The result reuses the table with an Outcome column (state 07).
5. Delete lives in the category dialog: an outlined error button at the start of the action bar (states 04, 10, 12). The delete question replaces the editor in the same dialog at the built 480 px width (state 08) and ends with the filled error action. The list rows hold no action, and a row opens its category.
6. The category table takes the grid look (header band, 42 px rows, resize marks, sort arrow) without filters, column menus, side bar, selection, and paging. An account holds at most 100 categories. The display name is the link that opens the category.
7. The attribute table uses compact Material fields (density -4, 40 px) and starts the error line 4 px in, so a row stays 49 px and an error fits its cell. Every other field keeps density 0 and the Material 16 px error indent.
8. The limit count sits under the page toolbar, and in the dialog beside Add attribute, the control that the limit disables (rules.md line 73).
9. The edit runs one job. Its link sits in the sub line under the title (states 06 and 07), so no jobs band repeats it above the table. The Failed tab with its count keeps failures one click away.
10. The saving step shows two phases at the built 480 px width: `Save changes in Google` with `0 of 2` and the bar, then `Update cached users`.
11. The wide steps take the full area under the header, as the built import dialog does, so the action bar stays in place across states 02 to 05, 07, 09, 10, and 12.
12. Read only (state 09): every value is plain text, the yes-or-no columns show disabled checkboxes, Delete category is absent, and Add attribute is disabled with `Requires the User Schema Manage permission.` beside it. The page shows no Create category.
13. Empty (state 11): the card of the Devices empty state with one Create category action. The toolbar drops its own Create category, so the page offers one primary continuation (rules.md UI-05).
14. Changed visibility (state 12): the changed field takes the pending surface of the in-grid draft cell (accent outline, selected fill). The 24-hour note sits under the table as a state line with the schedule glyph.
15. Help: an info icon button at the end of the page toolbar and in each dialog title row, as the built export and import dialog shows it.

## Questions that the screens expose

Product questions for the owner:

1. Last changed has no Google source. The schema resource holds no time, so the app knows only the changes of its own category jobs. Staff information shows `Not recorded` for a category made in the Google Admin console. Keep the column with that value, or drop the column? (owner)
2. The baseline gives Grade level a range of 0 to 12 (`numericIndexingSpec`). The editor has no range column. Add minimum and maximum for whole and decimal numbers, or leave ranges out of S2? (owner)
3. The removal of Homeroom deletes values on 1,988 users. Does the category job clear those values in the user cache (the second phase of state 06), or does the next user sync clear them? (owner and engineering)
4. At 100 of 100 attributes, a new category cannot hold an attribute. Does Create category on the page turn disabled with the limit note, or does the editor open and show the limit (state 10)? (owner)
5. Display names can repeat. State 03 shows a second Rider row whose attribute name repeats. Does the editor also require unique display names inside a category? (owner)
6. Google warns against sensitive personal data in custom fields (government IDs, financial and health data). The owner rule puts this in the help docs only. Confirm that the editor shows no warning in the flow. (owner)
7. State 09 shows the same navigation for the second person. A person with User Read only can lack Platform access and Platform invitations. Confirm the navigation for that person. (owner)

Per-field limits (for the design document):

- Category name and attribute name: letters, digits, _ and -. A category name is unique per customer (409 on reuse). An attribute name is unique in its category. Neither can change after creation. The maximum length is not in the baseline: engineering verifies it.
- Display name: the maximum length is not in the baseline: engineering verifies it.
- Account limits: 100 categories and 100 attributes.
- A visibility change can take up to 24 hours in Google.
- A change of Searchable on an existing attribute: the screens allow it. Engineering verifies that Google accepts `indexed` on an update.

Defects inherited from the reference builds and from the app:

- The review banner breaks service-account at its hyphen. The app does the same, and the screenshot shows it.
- `icon.css` of Angular Material holds `content: attr(fontIcon)`. No element of the mockup uses that class.
- The csv-slice-mockup-v4 footer strip sits 1 px off its page (see calibration).
- snapshot-states.cjs of drive-slice-figma requires Playwright from the docs-one-event-stream worktree. This folder holds a copy with one change: Playwright comes from the drive-df2-followups worktree, as the brief requires.

## App-sourced strings

Each string passes check-strings.py as a whole literal of `frontend/src/app` or `libs/application-contracts/src` at 7e7e81e, or it is the output of an app template with data.

- `Campus Commander`
- `Devices`
- `Jobs`
- `Google connection`
- `Customer settings`
- `Your account`
- `Diagnostics`
- `Schools`
- `Platform access`
- `Platform invitations`
- `Development review. Google sign-in and Workspace data are simulated. Use the sample service-account file. Do not upload real credentials.` (template: shell.html review notice, a strong element and its text)
- `Version development · Build client-review` (template: shell.html footer with the review build metadata)
- `Services ready`
- `Google results are out of date`
- `Display name`
- `Cancel`
- `Close`
- `Change`
- `Changes`
- `Succeeded`
- `Failed`
- `All changes`
- `Outcome`
- `·`
- `=`
- `+`
- `0 of 2` (template: the phase detail `done of total` of the export dialog)
- `Job CAT-003 · Running` (template: the job sub line of the export dialog, with the drafted CAT prefix)
- `Job CAT-003 · Completed · Student information` (template: the job sub line with the category name)
- `Finished Nov 1, 9:31 AM` (template: `Finished ${formatTimestamp(ended)}` of the results)

## Mockup data

- `example.org`
- `C0123456`
- `Review administrator`
- `Review recipient`
- `Device program`
- `DeviceProgram`
- `Staff information`
- `StaffInfo`
- `Student information`
- `StudentInfo`
- `Oct 19, 2026`
- `Sep 8, 2026`
- `1,312`
- `286`
- `2,104`
- `0` (count of the Failed term)
- `1` (attribute count and phase number)
- `2` (count and phase number)
- `4` (attribute count)
- `5` (attribute count)
- `Transportation`
- `Bus route`
- `BusRoute`
- `Stop name`
- `StopName`
- `Stop #`
- `Rider`
- `Student ID`
- `StudentId`
- `Grade level`
- `GradeLevel`
- `Graduation year`
- `GraduationYear`
- `Homeroom`
- `Programs`
- `Counselor`
- `Counselor (Email)`
- `Homeroom (Text)`
- `Employee ID`
- `EmployeeId`
- `Building`
- `Hire date`
- `HireDate`
- `Certifications`

## Drafted strings

The owner approves each one. Strings marked new use are app literals with another meaning in the app.

- `Users`
- `Google Workspace accounts`
- `Custom attributes`
- `Create category`
- `Edit category`
- `Delete category`
- `3 of 100 categories used · 10 of 100 attributes used`
- `0 of 100 categories used · 0 of 100 attributes used`
- `Category`
- `Category name`
- `Attributes`
- `Users with values`
- `Last changed`
- `Not recorded` (new use: the app shows it for a missing outcome reason)
- `No categories yet`
- `Google Workspace holds no custom attribute categories for this domain.`
- `Locks after the first save`
- `Attribute name`
- `Info type`
- `Multiple values`
- `Visibility`
- `Searchable`
- `Text`
- `Whole number`
- `Yes or no`
- `Email`
- `Date` (new use: the app holds it only as a test value)
- `Admins and the user`
- `Add attribute`
- `Remove attribute`
- `13 of 100 attributes used after this change`
- `14 of 100 attributes used after this change`
- `10 of 100 attributes used after this change`
- `100 of 100 attributes used. Remove an attribute before you add one.`
- `Review changes`
- `A category with this name exists.`
- `Use letters, digits, _ and - only.`
- `Each attribute needs a unique name.`
- `3 fields have errors`
- `Fixed at creation`
- `Cannot return to one value`
- `Removes values from 1,988 users`
- `2 changes to Student information`
- `The changes apply to every user in the domain.`
- `The change applies to every user in the domain.`
- `Attribute`
- `Effect` (new use: the app uses it as a column of a status help table)
- `No user values change`
- `Deletes its values on 1,988 users`
- `Removing Homeroom deletes its values on 1,988 users. Nothing restores them.`
- `Type Homeroom to confirm` (the app phrase label template with a new phrase)
- `Type Device program to confirm` (the app phrase label template with a new phrase)
- `Back to editing`
- `Save 2 changes`
- `Save changes in Google`
- `Update cached users`
- `Closing this dialog keeps the save running.`
- `Deletes Take-home approved values on 1,312 users.`
- `Requires the User Schema Manage permission.`
- `Google can take up to 24 hours to apply a visibility change.`

Accessible names that no state shows are drafted too: `Custom attributes help`, `Open category ...`, `Remove attribute ...`, `Keep attribute ...`, `Open job CAT-003`, `Users views`, `Results view`, `Result counts`, and `Remove` (the header of the remove column).

## Baseline defaults and owner questions by state

| Item | Recommended answer drawn | States | A different answer changes |
| --- | --- | --- | --- |
| Default 1, Users below Devices | Users item selected | all | Under U2 answer 2 the item moves under Customer settings in every state. |
| Default 2, Users grid columns | builder A | none | none |
| Default 3, Status values | builder A | none | none |
| Default 4, Filters | builder A | none | none |
| Default 5, User details | builder A and slice S3 | none | none |
| Default 6, Every write is a job | `CAT-003` runs the edit | 06, 07 | none |
| Default 7, New attribute defaults | Admins and the user, Searchable on | 02, 03, 04 | none |
| Default 8, Locked properties | name, info type, and multiple values back to one value | 04, 10, 12 | none |
| Default 9, Typed phrase and counts | count in the editor, phrase in review and delete | 04, 05, 08 | none |
| Default 10, Limits as counts | page line and editor line | 01 to 04, 10, 11, 12 | none |
| Default 11, Bulk modes | slice S3 | none | none |
| Default 12, Job prefixes | `CAT-` | 06, 07 | A new prefix changes the sub line of 06 and 07. |
| Default 13, Scenario data | three categories, 10 attributes | all | none |
| U1, What assigning means | values on users, categories for the whole domain | 05, 07, 08 | Answer 2 adds an organization unit column to 01 and a link step to 02 and 04, and the domain-wide lines change. |
| U2, Where categories live | a tab of the Users page | all | Answer 2 draws the page under Customer settings: navigation, header, and page title change in every state. |
| U3, Build order | S1, then S2, then S3 | none | Answer 2 builds the tab before the Users grid, so the Users tab has no content yet. |
| U4, Who sees definitions | User Read sees the tab read only | 09 | Answer 2 hides the tab for people without User Schema Manage: state 09 goes away. |
| U5, Bulk identifier values | slice S3 | none | none |
| Google fact, 24-hour visibility delay | state line under the table | 12 | none |
