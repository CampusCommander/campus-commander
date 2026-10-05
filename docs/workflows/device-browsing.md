# Browse ChromeOS devices

Status: owner-confirmed scope, 2026-10-05. Implementation authorized.
Source: [development order](../current-work.md#development-order-after-the-reset) steps 2 and 3, and the owner decisions below.
Design: Figma page 09. See [Design](#design) for the exact frames.
Replaces: none.

## User and outcome

The existing administrator browses the district's ChromeOS devices.
The administrator filters the inventory and opens one device's details, including battery health.
This slice reads data only. It changes nothing in Google Workspace.

## Interaction

The administrator opens Devices from the navigation.
The grid shows Serial, Model, Asset tag, Organization unit, Battery, and Device contact.
Annotated location and Notes are available columns, hidden by default, as in the [field contract](../ui/entity-grid-fields.json).
The eye icon in each row opens that device's details.

The filter row follows [GRID-04](../ui/patterns.md#entity-grid).
The administrator selects Add a filter, chooses a field or shortcut, and applies a typed value.
Each applied filter appears as a chip. Clear filters removes all chips.
The Refresh menu contains Refresh all. It runs a new device sync and keeps the active filters.
The footer shows the matching count, the district total, the inventory observation time, and the row range.

Device details show the serial, model, asset tag, OrgUnit path, and inventory observation time.
They show annotated location and notes as read-only values, and the last device contact.
The battery panel shows the Google health class and the percentage of design capacity.
It names Google as the classification source. It shows the latest report time and the recent reports that Google provides.
Back to devices restores the filters and scroll position. Next device follows the current filtered order.

## Data and access

| Data | Google source | Scope suffix |
| --- | --- | --- |
| Device inventory | Directory API `chromeosdevices.list` | `admin.directory.device.chromeos.readonly` |
| Battery | Chrome Management API `customers.telemetry.devices.list`, `batteryInfo` and `batteryStatusReport` | `chrome.management.telemetry.readonly` |

All scopes use the `https://www.googleapis.com/auth/` prefix.
Inventory fields are `deviceId`, `serialNumber`, `model`, `annotatedAssetId`, `orgUnitPath`, `lastSync`, `annotatedLocation`, and `notes`.
Battery percentage is `fullChargeCapacity` divided by `designCapacity`.
Google reports battery data only when the `ReportDevicePowerStatus` device policy is on.

Campus Commander syncs the complete device inventory and battery reports into its own database.
The grid, filters, and counts query that database through the server-side row model in [GRID-01](../ui/patterns.md#entity-grid).
Each completed sync replaces the previous one. A failed sync leaves the previous inventory in place and shows the stale state.
Collection leases, staging generations, and write overlays from the [architecture](../portfolio/03-architecture.md#synchronization-and-effective-reads) wait until device writes exist.

The existing administrator sees every device.
Device Read permissions scoped by access assignments wait for the [platform-access](platform-access.md) implementation.

The simulated review environment supplies simulated devices and battery reports for demonstration.
Live read-only checks use the [Easton fixture](../portfolio/phase-3-google-credentials.md#standing-test-authorization--2026-09-17).
The owner must add both scopes to the delegation client in the Google Admin Console before those checks.
An empty device collection is a valid live result.

## Owner decisions — 2026-10-05

**Battery is in this slice.** The owner chose "Include battery now" over deferring battery to its own workflow.

**No School column.** The owner chose "OrgUnit path only". The Organization unit column supplies location context.
Schools have no defined entity. Revisit the column after that definition exists.

**Google classifies battery health.** The owner chose Google's classification over district thresholds.

| Class | Google definition |
| --- | --- |
| Normal | Full charge capacity is above 80% of design capacity. |
| Replace soon | Full charge capacity is 75% to 80% of design capacity. |
| Replace now | Full charge capacity is below 75% of design capacity. |

No district threshold setting exists. The design text "District policy: Replace soon below 80%" changes to name Google as the source.

## States

Implement the designed loading, empty, offline, and stale states.
A filter with no matches shows the no-matches state with Clear filters.
A device without battery data shows the reason when it is known: policy off, unsupported device, or no report yet.
Follow [DETAIL-02](../ui/patterns.md#entity-detail). Missing reports are not healthy readings.

## Examples

- The administrator filters "Asset tag starts with HS-04" and "Battery is Replace soon". The footer shows six matching devices.
- The administrator opens C0A1-7F2D. The panel shows "Replace soon" and 78% of design capacity, classified by Google.
- Next device opens C0A1-7F31, the next row in the filtered order.
- A device without the power-status policy shows that battery reporting is off.
- A sync fails. The grid keeps the previous inventory and shows the stale state with its observation time.

## Design

Inspected on 2026-10-05 in [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2).

| Screen | Node |
| --- | --- |
| Inventory | `94:3` |
| Details | `94:39` |
| Filter picker and matches | `175:1337`, `175:1562` |
| Filter editors: text, date, enum, OrgUnit | `176:1503`, `176:1951`, `176:2181`, `176:2636` |
| Applied and cleared filters | `177:2032` through `177:3280` |
| Loading, empty, offline, stale | `107:317`, `107:447`, `108:173`, `108:605` |
| Telemetry state | `105:146` |

Deviations from the frames: no School column, no selection column or footer selection controls, and no Bulk Actions or Update device.
The battery panel names Google's classification instead of a district policy.

## Exclusions

- School column and any school entity.
- Row selection, Select All, Show All Selected, Refresh selected, and Bulk Actions. They arrive with the first device action.
- In-grid editors, Update device, commands, status changes, and CSV.
- Saved filters and personal grid preferences ([G12](../workflow-gaps.md#remaining-product-and-interaction-gaps)).
- Access-assignment enforcement and district battery thresholds.

## Completion

Demonstrate in the simulated review environment:

1. Browse the device grid and show and hide the optional columns.
2. Apply and remove a filter of each visible field type, then clear all filters.
3. Open details, use Next device, and return with filters and position intact.
4. Show each battery class and the no-report reasons.
5. Show the loading, empty, no-matches, offline, and stale states.

Run lint, tests, and builds for the affected Nx projects. Add API tests for the query contract and an end-to-end test for the main flow.
Run the live read-only check after the owner configures the scopes.
