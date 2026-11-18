# Custom attributes, number range: approved mockup notes (version 2)

Status: approved. On 2026-11-18 the owner approved states 13 to 15. Owner, in the main chat: "approve".

## Approval and build rulings

- Stored files: [`2026-11-18-custom-attributes-ranges.html`](2026-11-18-custom-attributes-ranges.html), [`2026-11-18-custom-attributes-13-number-range.png`](2026-11-18-custom-attributes-13-number-range.png), [`2026-11-18-custom-attributes-14-range-errors.png`](2026-11-18-custom-attributes-14-range-errors.png), and [`2026-11-18-custom-attributes-15-review-range.png`](2026-11-18-custom-attributes-15-review-range.png).
  These notes call them `custom-attributes-mockup.html` and `png/`. The names `brief.md`, `snapshots/`, and `work/` name files of the mockup workspace, which the repository does not hold.
- The mockup holds the 12 approved states of [version 1](2026-11-16-custom-attributes.html) and the new states 13, 14, and 15. States 01 to 12 render equal to the approved PNGs of version 1. Version 1 stays the source of states 01 to 12.
- Before the approval, the owner answered questions 1 and 2 of the section "Questions that the screens expose". Owner, in the main chat: "R1) No" and "R2) yes".
  - R1: the review keeps `No user values change`. It counts no users with a value outside a new range.
  - R2: a range can hold one bound. An empty bound sets no limit.
- The approval accepts three stated defaults:
  - The range line sits under each number row.
  - A range stays editable after the first save.
  - The help docs carry the refusal of a value outside the range, and the flow does not (question 3).
- Card K19 of the [design addendum](../../superpowers/specs/2026-11-16-user-management-design.md) builds the range inputs from these states.
- Figma: frames `470:2`, `471:2`, and `472:2` on page 12, Custom Attributes (`291:3`).

## Owner direction

The owner wrote on 2026-11-01: "I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma."

On 2026-11-16 he answered questions U1 to U7: "All recommended".
Later on 2026-11-16 he approved states 01 to 12 with four named defaults: "1) Approved".

Record default 3: "The design adds an optional range for number attributes, for example Grade level 0 to 12. The frames do not draw it."
Before this mockup, no frame drew the number range inputs of default 3. The record kept that design gap open (section Design).
Card K19 waited for a frame that the owner approves (design addendum, entry K19).
States 13 to 15 draw that frame.

The screens apply the standing UI rules of the owner:

- No line in the flow explains what a range does. The info icon button of the dialog title row leads to the help docs.
- The flow shows state messages only: the two errors of state 14, the error count, and the attribute count.
- The shell shows `example.org`, `example.org`, and `C0123456`.
- The screens show only the raw data: no sample row, no preview, and no decoration.

The shell keeps the review build header of version 1.
The banner reads "Development review. ..." as the app shows it.
The footer strip shows the version line, `Services ready`, and `Google results are out of date`.
The approved PNGs of version 1 show the same header, so the build card lists it as an accepted exception.

## States

The three new states are viewport captures at 1440 x 900 with deviceScaleFactor 1, in the light theme.
Each state is a dialog state. The capture holds the page, the scrim, and the dialog, with the dialog fixed to the viewport.

| # | State | Content |
| --- | --- | --- |
| 13 | `number-range` | The editor for Student information. Grade level shows the range 0 to 12, which the person entered. Graduation year shows two empty range fields. Review changes is enabled. |
| 14 | `range-errors` | State 13 with two in-flow errors: Grade level has minimum 12 and maximum 0, and Graduation year has minimum 2026.5. Review changes is disabled. |
| 15 | `review-range` | The review step for the change of state 13: one row for the new Grade level range with its effect. No typed phrase gate. Save 1 change is enabled. |

Deep links `#13-number-range`, `#14-range-errors`, and `#15-review-range` work on a fresh load and on a hash change. render.cjs tests three pairs.
The state switcher sits in a shadow root. No PNG and no snapshot holds it.

## Changes from version 1

| State | Change | Design gap that it closes |
| --- | --- | --- |
| 13 | A range line under each Whole number or Decimal number row, with a Minimum field and a Maximum field. | The record gap of default 3: no frame drew the range inputs (record, section Design, and CA notes ruling 2 and question 2). Card K19 can start after approval. |
| 14 | The field error pattern of state 03 on the range fields. | The invalid values of a range: a minimum above the maximum, and a decimal bound on a Whole number attribute. Document B section 5 names the range but no error. |
| 15 | The review table of state 05 with one row for a range change, and no typed phrase. | The review of a range edit. Document B section 6.1 sends a range edit as `schemas.update` (`docs/research/custom-user-attributes-technical-design.md:183`). States 05 and 07 draw only an added and a removed attribute. |

Other changes:

- The page under the scrim of states 13 to 15 drops the Last changed column (CA notes, ruling 1). The empty last column keeps the grid geometry. So the PNGs show the same strip as state 04.
- `window.mockup` also exposes `NEW_STATES`. render.cjs and snapshot-states.cjs use it as their default. So `png/` and `snapshots/` hold the new states only.
- The scripts require Playwright from the worktree `fix-fatal-batch-check-order`, as the brief requires. Version 1 used another worktree.
- The snapshot prefix is `custom-attributes`, as the brief names it. Version 1 used `attrs`.
- build.py reads `work/theme/theme.css`, so this folder also holds a copy of `work/theme/` from version 1.
- New scripts: `work/regress-compare.py` (the version 1 compare) and two calibration cases in `work/cal/`. `work/scan-terms.py` also runs the grep command of the brief and an identity scan.

## Scenario and data

- The scenario of version 1 stays: Sunday, November 1, 2026, 9:30 AM Eastern. The person is Review administrator, with User Schema Manage.
- Student information (`StudentInfo`) holds five attributes: Student ID, Grade level, Graduation year, Homeroom, and Programs.
- Grade level (`GradeLevel`) and Graduation year (`GraduationYear`) are Whole number attributes. Programs holds multiple values.
- Before the edit, no attribute holds a range. In state 13 the person enters Grade level 0 to 12. Graduation year keeps no range.
- Every count of version 1 stays: 3 of 100 categories and 10 of 100 attributes.
- Student information keeps 5 attributes and 2,104 users with values.
- A range edit adds no attribute. So the editor shows `10 of 100 attributes used after this change`.
- State 14 changes only the range values: Grade level 12 and 0, Graduation year 2026.5 and an empty maximum.
- State 15 reviews the change of state 13: `1 change to Student information`.

## Fidelity and calibration

Every element is HTML and CSS. No state uses a screenshot or an image.
In each new state, render.cjs counts 0 `img`, 0 `canvas`, and 0 elements with a background image.

- CSS, fonts, theme, and icons are the files of version 1. The app CSS, `styles.scss`, and `docs/ui/tokens.json` hold no change between main 7e7e81e and HEAD d622031 of the worktree. Its frontend, libs, and api trees equal origin/main 8787c03.
- `work/material/extract.py` and `work/icons.py` ran again on the worktree `fix-fatal-batch-check-order`. Every output file equals version 1 byte for byte (Angular Material 22.2.2).
- The range fields are compact Material outline fields with a floating label. Composition choice 7 of version 1 sets their size: density -4, 40 px.

Calibration (`work/cal/`): `cal.cjs` injects each case from the harness, so the deliverable holds no calibration string. `cal.py` reads the screenshots from `custom-attributes-mockup/ref/` of version 1, read only.

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
| Field with resting label (new) | 45-phrase-gate-disabled | 0.000 | none | 0.000 |
| Field with floated label (new) | 47-phrase-ready | 0.000 | none | 0.000 |
| Wide dialog head | 13-review-proposed | 0.000 | 1.844 | 0.029 |

- The two new cases re-create the typed phrase field of the import dialog. It is 720 x 56 at x 360 and y 609. They prove the resting label, the floated label, the notch, and the value text that the range fields use. The floated case differs in 2 pixels by 1 step.
- The other cases give the values of version 1 exactly. Icons differ at their edges only, as version 1 records: the Figma rule draws them as SVG.
- The footer strip of `csv-slice-mockup-v4` sits 1 px off the mockup footer, as version 1 records.
- The heat images `diff-*.png` keep only the measured regions. A full-frame heat image draws the identity lines of the screenshot.

Checks:

- render.cjs finds no request, no page error, and no console error in each new state.
- It finds no clipped text, no element outside the dialog, nothing past 1,440 px, and no scrolling dialog body.
- It finds no broken word except the banner break of service-account.
- The attribute table keeps the column widths of version 1: 196, 224, 168, 104, 240, 88, and 50 px.
- Each Whole number row has a range line, and no other row has one. Each range field fills its cell (208 px and 152 px).
- `work/regress-compare.py`: `node render.cjs --regress` renders states 01 to 12 from the version 2 HTML. All 12 equal the approved PNGs of version 1 pixel for pixel (`work/regress/regress-check.json`).
- `work/snapshot-check.cjs`: each of the 3 snapshots renders alone and equals its PNG pixel for pixel. Each holds no script and no image and stays under 320 KB.
- `work/scan-terms.py` finds 0 forbidden-term hits as bytes and 0 lines with the grep command of the brief.
- It finds no identity value other than `example.org` and `C0123456`.

## Composition choices (numbered)

1. Range input position: a second line under each Whole number or Decimal number row. Minimum sits under Attribute name and Maximum under Info type. Each field fills its cell at the built compact field size (40 px), as every field of the table does. The line has no top rule, and its Display name cell stays empty. So it reads as part of the attribute above it.
   Reason: this keeps every column at its version 1 width. One Range column with two narrow fields needs about 160 px. The six columns already fill the 1,070 px panel.
2. A range stays editable after the first save. The locked properties of document B section 5 list no range (`docs/research/custom-user-attributes-technical-design.md:154-162`). Section 6.1 lists the range among the edits that `schemas.update` sends (line 183). Change C3 of the design keeps a range on every update (`docs/superpowers/specs/2026-11-16-user-management-design.md:58`). So the range shows as fields in every edit state, never as locked text.
3. Every error text of state 14 and the review row of state 15 are drafted. The list under Drafted strings marks each one.
4. A changed range field takes the pending surface of state 12: the accent outline and the selected fill. Composition choice 14 of version 1 defines it. An invalid field shows the error look instead.
5. Each range field carries its own floating label, `Minimum` or `Maximum`. The range line has no column header, and rules.md UI-05 asks for persistent field labels. The accessible names add the attribute, for example `Grade level minimum`.
6. Each error marks one field, in the pattern of state 03. A minimum above the maximum marks the Maximum field with `Enter 12 or more.`, which names the minimum. A decimal bound on a Whole number attribute marks its field with `Enter a whole number.`. The approved users mockup uses that text in state 05. The action bar counts `2 fields have errors`, and Review changes is disabled.
7. An empty field means no bound. A range can hold one bound only, because the contract allows each bound to be empty (`libs/application-contracts/src/lib/users.ts:451-452`). State 14 shows Graduation year with a minimum and no maximum.
8. The review row of state 15 holds three cells. The change chip is `Set range` with the info tone. The attribute cell is `Grade level 0 to 12`. The effect is `No user values change`.
   The attribute cell copies the phrase of default 3 and the filter chip form of the users mockup. Google does not enforce the range, so no stored value changes.
9. State 15 shows no typed phrase gate. Document B section 5 asks for a typed phrase only for two changes (`docs/research/custom-user-attributes-technical-design.md:164-169`). They are a plan that removes an attribute and a category delete. So `Save 1 change` is enabled at once. The domain line takes the singular text of state 08.

## Questions that the screens expose

Owner answers, 2026-11-18, main chat: "R1) No" and "R2) yes". R1 is question 1: the review keeps `No user values change` and counts no users outside a new range. R2 is question 2: a range can hold one bound. Question 3 stays a stated default: the help docs carry the refusal, and the flow does not. Owner, 2026-11-18, main chat: "approve". This approves states 13 to 15 with the answers above and the stated defaults.

Product questions for the owner:

1. A new or narrower range can exclude values that users already hold. State 15 says `No user values change`, and that is true in Google.
   Should the review also count the users with a cached value outside the new range? Or does the row stay as drawn? Recommendation: keep the row as drawn for the first build. (owner)
2. Can a range hold one bound only? The contract allows it, and state 14 draws a minimum without a maximum. Recommendation: yes. (owner)
3. The effect cell does not say that Campus Commander now refuses a value outside 0 to 12 (E11). Your rule keeps explanations in the help docs. Confirm that the help docs carry this effect and the flow does not. (owner)

Per-field limits (for the design document):

- A bound of a Whole number attribute is a whole number. A bound of a Decimal number attribute is a finite number. Google stores both as `minValue` and `maxValue` of `numericIndexingSpec`.
- The minimum is at or below the maximum. An equal minimum and maximum pass, as the filter rule of the contract does (`users.ts:186-187`).
- A bound of a Whole number attribute stays within the JSON safe range of E10.

Design gaps that the build closes with these choices (no owner question):

- States 02 to 12 of version 1 draw no range line.
- The build adds the line to each number row in every editor state, such as 04 and 10.
- A new row gets the line when the person picks a number info type.
- The read-only state 09 draws no range. The build shows the bounds as plain text in the range line (composition choice 12 of version 1).
- No state draws the review row of a changed or a cleared range. The build reuses the row of state 15 with the new range.

Defects inherited from version 1:

- The heat images of version 1 (`work/cal/diff-*.png`) are full-frame. They draw the tenant identity lines of the real screenshots. Version 2 keeps only the measured regions. The version 1 folder stays unchanged.
- States 01 to 12 keep the Last changed column that ruling 1 drops. The new states follow the ruling under the scrim.
- The review banner breaks service-account at its hyphen. The app does the same.
- The footer strip of `csv-slice-mockup-v4` sits 1 px off its page.
- The check-strings corpus now holds test fixtures and code comments of the contracts. `users.test.mjs` holds scenario names such as `Grade level`, and a comment of `users.ts` holds `Admins and the user`. A literal match there does not make a string app-sourced, so these notes keep such strings as data or drafted.

## App-sourced strings

Each string passes check-strings.py as a whole literal of `frontend/src/app` or `libs/application-contracts/src` at HEAD d622031.
A string marked template is the output of an app template with data.

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
- `Change`

## Mockup data

- `example.org`
- `C0123456`
- `Review administrator`
- `Device program`
- `DeviceProgram`
- `Staff information`
- `StaffInfo`
- `Student information`
- `StudentInfo`
- `1,312`
- `286`
- `2,104`
- `1` (attribute count)
- `4` (attribute count)
- `5` (attribute count)
- `Student ID`
- `StudentId`
- `Grade level`
- `GradeLevel`
- `Graduation year`
- `GraduationYear`
- `Homeroom`
- `Programs`
- `0` (a bound of Grade level)
- `12` (a bound of Grade level)
- `2026.5` (the invalid minimum of Graduation year)

## Drafted strings

The owner approves each one.
A string marked new in version 2 is new in this mockup.
The approved states of version 1 hold the other strings, and they stay drafted.
Strings marked new use are app literals with another meaning in the app.

- `Users`
- `Google Workspace accounts`
- `Custom attributes`
- `Create category`
- `3 of 100 categories used · 10 of 100 attributes used`
- `Category`
- `Category name`
- `Attributes`
- `Users with values`
- `Edit category`
- `Fixed at creation`
- `Attribute name`
- `Info type`
- `Multiple values`
- `Visibility`
- `Searchable`
- `Text`
- `Whole number`
- `Admins and the user` (new use: only a code comment of users.ts holds it)
- `Cannot return to one value`
- `Add attribute`
- `10 of 100 attributes used after this change`
- `Delete category`
- `Review changes`
- `Minimum` (new in version 2)
- `Maximum` (new in version 2)
- `Enter 12 or more.` (new in version 2: the template `Enter <minimum> or more.`)
- `Enter a whole number.` (new in version 2: the drafted text of the users mockup state 05)
- `2 fields have errors` (new in version 2: the count template of state 03)
- `1 change to Student information` (new in version 2: the count template of state 05)
- `The change applies to every user in the domain.`
- `Attribute`
- `Effect` (new use: the app uses it as a column of a status help table)
- `Set range` (new in version 2)
- `Grade level 0 to 12` (new in version 2)
- `No user values change`
- `Back to editing`
- `Save 1 change` (new in version 2: the count template of state 05)

Accessible names that no state shows are drafted too.
Version 2 adds `Grade level minimum`, `Grade level maximum`, `Graduation year minimum`, and `Graduation year maximum`.
Version 1 already holds `Remove`, the header of the remove column.
