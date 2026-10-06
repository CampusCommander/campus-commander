# Browse ChromeOS devices

Status: owner-confirmed scope, 2026-10-05. Implementation authorized. Per-device freshness added 2026-10-06.
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
The Refresh menu contains Refresh all. It runs a full device sync and keeps the active filters.
The grid pages through the devices. The paging bar shows the row range and the page size.
Each column header has a filter. The Filters side bar lists the same filters.
The Columns side bar shows, hides, orders, and pins columns.
The checkbox column selects devices. Select All in the status bar selects every device that matches the filters.
The status bar shows the matching count, the district total, the last full sync time, and the selection.
The column menu and the Columns side bar group the grid by organization unit, model, or battery class. Each group row shows its device count.

Device details show the serial, model, asset tag, OrgUnit path, and the time Campus Commander last read the device from Google.
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

Campus Commander keeps one row per device in its own database, with the time it last read that device from Google.
The grid, filters, and counts query that database through the server-side row model in [GRID-01](../ui/patterns.md#entity-grid).
Redis holds short-lived query results and the rows that a sync refreshed. The [entity cache record](../superpowers/specs/2026-10-06-entity-cache-decisions.md) defines both caches.
A device is stale 24 hours after its last read. A query that returns stale devices starts a background refresh of every stale device it matched.
The server pushes a signal when refreshed rows land, and the grid updates those rows in place.
Refresh all reads the complete inventory. A failed full sync leaves every row in place and shows the stale state.
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

**Grid features.** The owner chose these LibreGrid features on top of the server-side row model:

- Column tools: the column menu and the Columns side bar for showing, hiding, reordering, pinning, and resizing columns.
- Server-side selection with a status bar, including Select All across the filtered set.
- Server-side grouping by OrgUnit, model, or battery class, with counts per group.

Excel export, cell range selection, and clipboard copy are not part of this slice.

**Paging.** The owner asked for paging in the device grid.
The grid pages through the server-side row model. Back to devices returns to the page and row of the opened device.

**Filtering.** The owner chose to keep the chip filter row and add AG Grid column filters.
The column filters include set filters for Battery and OrgUnit and the Filters side bar.
Chips and column filters stay in sync and drive one server query.

## Owner decisions — 2026-10-06

**Per-device freshness.** The owner replaced the whole-inventory snapshot with one row per device and a per-row last read time.
The owner confirmed the decisions D1 through D15 in the [entity cache record](../superpowers/specs/2026-10-06-entity-cache-decisions.md) in one interview.
This work is infrastructure under this workflow. It is not a new workflow. Development continues on `codex/entity-cache`.

- A stale device is one that Campus Commander read from Google more than 24 hours ago.
- A grid query refreshes every stale device it matched, in parallel batches through Kestra.
- The stale banner shows "Refreshing N of M devices" while a refresh runs and disappears when the last batch lands.
- A stale row shows its Last contact cell muted with the tooltip "Refreshing from Google".
- The server pushes refresh signals over Server-Sent Events. The 2 second status poll is removed.
- Google returning 404 for one device marks that device removed. Removed devices stay in the database.
- A full sync marks every device that Google no longer returns as removed, when every batch of that sync succeeded.
- Nothing is deleted from the database.

## Implementation defaults — 2026-10-05

These defaults are engineering choices, not owner decisions. Change them when the owner asks.

- The inventory lists every device that Google returns, including deprovisioned devices.
- Text filters ignore letter case. "Contains" and "starts with" treat `%`, `_`, and `\` as ordinary characters.
- A "before" date filter excludes the given time. An "after" filter includes it.
- Date filters exclude devices without a contact time.
- A device becomes stale 24 hours after Campus Commander last read it. The threshold is a code constant per entity type.
- Query results stay cached for 5 minutes. A completed full sync makes the cached results unreachable.
- A sync that no worker starts within two minutes ends as interrupted. Refresh all then becomes available again.
- The first visit shows no devices until an administrator runs Refresh all.
- Pages hold 100 devices by default. The page size selector offers 50, 100, and 250.
- Without a Google connection, Devices directs the administrator to the Google connection page.
- The Columns side bar shows or hides Annotated location and Notes. It replaces the Columns menu in the filter row.
- Each field has one filter. A chip for a field that already has a column filter replaces that filter.
- The OrgUnit set filter lists the OrgUnits that hold devices as a tree. Choosing a unit in the filter row includes the units inside it.
- An empty set filter matches no devices.
- Enter on the details cell opens device details. Space toggles the row's selection.
- A selection belongs to one person and one browser tab. It survives reloads of that tab and expires 12 hours after its last change.
- The status bar names the filters that Select All captured and counts the devices added or excluded since.
- An expired selection shows as empty. The expired-selection state from SELECT-01 arrives with the first device action.
- The selection footer uses the LibreGrid labels: Select All, Deselect All, Show All Selected, and Show All Records.
- The edge content security policy allows `data:` images, because AG Grid draws its icons with them. Scripts stay same-origin.
- Groups nest up to three levels, each field once. Group keys are exact OrgUnit paths, model names, and battery classes. Devices without a model form the group "No model".
- An open group lists up to 1,000 devices, and a grouped level lists up to 1,000 groups. The status bar says when a group holds more.
- While the grid is grouped, checking any row selects or deselects its whole group, as LibreGrid defines. A selected group keeps the filters that were active.
- Next device from a device inside a group follows that group's order. Back to devices restores the grouping, filters, sort, and page. Open groups close.
- A refresh job holds 100 devices per batch. Kestra runs four batches at a time. The in-flight set expires after two minutes.
- The grid and counts exclude removed devices. Device details still open a removed device and name the removal time.
- A refresh that cannot start leaves the page as it is. The next query tries again.
- The status bar and group counts still show the last full sync time. Device details show the device's own last Google read.

## States

Implement the designed loading, empty, offline, and stale states.
A filter with no matches shows the no-matches state with Clear filters.
A device without battery data shows "No battery report".
That message names two common causes: the `ReportDevicePowerStatus` policy is off, or the device has no battery.
Google withholds battery data in both cases, so Campus Commander cannot tell them apart.
A failed telemetry read shows battery data as unavailable for every device.
Follow [DETAIL-02](../ui/patterns.md#entity-detail). Missing reports are not healthy readings.

## Examples

- The administrator filters "Asset tag starts with HS-04" and "Battery is Replace soon". The footer shows six matching devices.
- The administrator opens C0A1-7F2D. The panel shows "Replace soon" and 78% of design capacity, classified by Google.
- Next device opens C0A1-7F31, the next row in the filtered order.
- A device without battery reports shows "No battery report" and names the power-status policy as a common cause.
- A full sync fails. The grid keeps every row and shows the stale state.
- The administrator opens Devices after a day away. Stale rows show muted contact times, the banner reads "Refreshing 1 of 12 devices", and rows refresh in place as batches land.

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

Deviations from the frames: no School column, no Bulk Actions, and no Update device.
The battery panel names Google's classification instead of a district policy.
The battery coverage page (`105:146`) is excluded. Device details list the recent reports that Google returns.

## Exclusions

- School column and any school entity.
- Refresh selected and Bulk Actions. They arrive with the first device action. Selection itself is in scope.
- Excel export, cell range selection, and clipboard copy.
- In-grid editors, Update device, commands, status changes, and CSV.
- Saved filters and personal grid preferences ([G12](../workflow-gaps.md#remaining-product-and-interaction-gaps)).
- Access-assignment enforcement and district battery thresholds.

## Completion

Demonstrate in the simulated review environment:

1. Browse the device grid and show and hide the optional columns.
2. Apply and remove a filter of each visible field type, then clear all filters.
3. Open details, use Next device, and return with filters and position intact.
4. Show each battery class, a device without reports, and unavailable telemetry.
5. Show the loading, empty, no-matches, offline, and stale states.
6. Filter from a column header and see the matching chip. Show and hide a column from the Columns side bar.
7. Select All under a filter, change the filters, and use Show All Selected.
8. Move to a later page, open a device there, and return to that page.
9. Group by each of the three fields, open a group, select it, and use Next device inside it.

Run lint, tests, and builds for the affected Nx projects. Add API tests for the query contract and an end-to-end test for the main flow.
Run the live read-only check after the owner configures the scopes.
