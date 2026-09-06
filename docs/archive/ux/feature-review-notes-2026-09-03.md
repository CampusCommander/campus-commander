# Feature Review — Raw Brain Dumps (2026-09-03)

Unstructured owner feedback captured while reviewing the prototype after the 2026-09-02 design review round. Recorded verbatim at capture time. Not groomed. When the dump is complete, groom this list and record the features into the appropriate design docs (`ui-design-guide.md`, `design-review` follow-up, spec updates).

## Dumps

### Dump 1 — In-grid batch edit mode (main grid views)

- We will make use of in-grid batch edit in the main grid views.
- When any field is changed in the grid, default to batch edit mode.
- Toolbar (top of grid) in batch edit mode shows:
  - number of changed fields
  - a Save button
  - a Reset button
- Filter option toggles between "show all rows with pending changes" and "show all". (We need copy for that filter — reason: not yet written.)
- Save creates a job with the changes and executes it (fits the existing select → preview → confirm → job chain / Jobs surfaces).
- Additional: visual styling so users see at a glance which fields have pending changes.
- Additional: an icon on each changed cell to roll back that cell's change.

### Dump 4 — Google Admin Console chip/filter component

- Create a component that matches the Google Admin Console chip and filter UI/UX (search and filter chips in the Google Admin Console style).

### Dump 2 — "Update device" bulk action for devices

- Add an option in the bulk actions menu (Devices): **Update device**.
- Opens a dialog showing:
  - how many devices are selected
  - which fields are editable
- Use case: bulk update the Notes field on a large batch of Chromebooks; or change the Annotated Location from Smith Elem to Washington Middle.
- Editable fields for devices: org unit, and all the annotated fields.
- Each editable field gets an operation mode: **Prepend** / **Update** / **Append**.
- Follows the preview → confirm → job chain.

### Dump 3 — Round-trip export/import (edit in spreadsheet)

- We need a unique export and import pair (distinct from the existing one-way export and the CSV import).
- Export creates a CSV or Google Sheet.
- The user updates the data in the spreadsheet, then re-imports it.
- Re-import runs: validation → preview → confirm → create job.
- There will be some complex workflows here. This needs its own design session before implementation.
- NOTE: this export/import entry point lives nested under the bulk actions dropdown menu.
