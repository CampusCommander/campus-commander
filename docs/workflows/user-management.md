# Google users and custom attributes

Status: slice S1 signed off on 2026-11-18. Slice S2 is in build. Slice S3 and the live read-only check stay open.
On 2026-11-16 the owner answered questions U1 to U7 and approved the screens. The [design addendum](../superpowers/specs/2026-11-16-user-management-design.md) holds the card plan.

On 2026-11-01 the owner started this workflow, development order step 6 (gap G19). Owner, in the main chat:

> I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma.

On 2026-11-16 the owner answered the seven questions under [Owner decisions](#owner-decisions). Owner, in the main chat: "All recommended".

Later on 2026-11-16 the eng-lead asked for three answers. The owner replied in the main chat:

1. The eng-lead asked him to approve the screens of both Figma pages, with four named defaults. Owner: "1) Approved".
2. The eng-lead asked him to add the two user read scopes to the delegation. Owner: "2) Scopes Added".
3. The eng-lead asked for his yes to publish admin-sdk-mock 0.4.0. Owner: "3) Yes to 0.4.0".

Later on 2026-11-16 the owner answered three more questions of the design addendum. Owner, in the main chat:

- The eng-lead asked him to add the two user write scopes `admin.directory.user` and `admin.directory.userschema` beside the two read scopes. Owner: "2) Added all four".
- OQ1: the eng-lead asked for his yes to live checks L2 and L3 on a test user that he names. Owner: "3) yes", with the address of a test user of his domain.
- OQ2: the eng-lead asked whether User Read also opens Jobs. Owner: "4) yes later". Jobs opens for User Read later, with gap G03.

On 2026-11-18 the owner answered the two questions of the number range states. Owner, in the main chat: "R1) No" and "R2) yes".
R1 keeps the review row `No user values change` without a count of users outside a new range. R2 lets a range hold one bound.
He then approved states 13 to 15. Owner: "approve".

On 2026-11-18 the owner signed off slice S1, Browse users. The sign-off package README asked: "Reply `sign off` to accept slice S1 as built." Owner, in the main chat: "sign off".

Source: owner direction of 2026-11-01 and 2026-11-16, quoted above.

Design: Figma [page 11, User Management](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=291-2) and [page 12, Custom Attributes](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=291-3), with the frame table under [Design](#design).
The approved mockups [user management](../ui/designs/2026-11-16-user-management.html), [custom attributes](../ui/designs/2026-11-16-custom-attributes.html), and [number range](../ui/designs/2026-11-18-custom-attributes-ranges.html) and their notes set the screens. They outrank this record on composition.

Technical design: [Google user management](../research/google-user-management-technical-design.md) (document A) and [custom user attributes](../research/custom-user-attributes-technical-design.md) (document B). Both stay proposed.
The [planning baseline](../research/user-management-planning-baseline.md) holds the vocabulary, the slices, and the defaults that both documents cite.

Replaces: the September Users frames of Figma page 10 as the design source of gap G19.

## User and outcome

An administrator manages Google Workspace user accounts in the look of the built Devices pages.
The administrator browses and filters users, opens one user, and sets custom attribute values.
A person with User Schema Manage creates and changes the custom attribute categories. Google calls a category a schema.
These are Google accounts, not platform access.

## Interaction

- Users sits directly below Devices in the navigation. The page has two tabs: Users and Custom attributes.
- The Users tab copies the Devices grid: typed filters, columns, selection, paging, and Refresh. Attribute columns start hidden under their category.
- The eye icon opens the user details: the Account, Organization, and Custom attributes cards.
- Values change on one user, in the grid, or on selected users through Bulk Actions, Set attributes.
- The Custom attributes tab lists the categories with the limit counts. Create, edit, and delete use one dialog: editor, review, job, and result.
- Every Google write shows a review, runs as a job, and reports its result in the same dialog.

## Permissions and failures

- User Read shows both tabs. The Custom attributes tab shows read only (U4).
- User Read applies to the whole domain until OrgUnit collections exist (U6).
- User Schema Manage adds category create, edit, and delete. Values need User Write (`docs/workflows/platform-access.md:712-714`).
- User Write and User Bulk Actions each include User Read (`docs/workflows/platform-access.md:696`).
- Document A section 11 defines the page states. Document B section 13 defines the failures of category and value jobs.

## Owner decisions

On 2026-11-16 the owner answered "All recommended". Each question takes option 1.

| ID  | Question                                                                                               | Chosen option                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | What does "assigning" a schema mean?                                                                   | Set attribute values on users: on one user, in the grid, on selected users, and later in the import file. Every category exists for the whole domain, as in Google. |
| U2  | Where do categories get managed?                                                                       | A "Custom attributes" tab on the Users page, beside a "Users" tab.                                                                                                  |
| U3  | Which slice builds first?                                                                              | S1 Browse users, then S2 Manage categories, then S3 Set attribute values.                                                                                           |
| U4  | Who can see category definitions (the recorded open item)?                                             | Every person with User Read sees the Custom attributes tab read only. User Schema Manage adds create, edit, and delete.                                             |
| U5  | Can Bulk "Set attributes" write one value to an identifier attribute such as Student ID on many users? | Yes. Bulk offers every attribute, and the review lists every user. Identifier values go in one user at a time or through the later import.                          |
| U6  | Does S1 ship User Read at district scope before OrgUnit collections exist?                             | Yes. S1 checks User Read for the whole domain, as Device Read does today (`docs/workflows/device-browsing.md:61`). The query takes an OrgUnit scope from the start. |
| U7  | When an attribute or a category goes away, does Campus Commander clear the values on users first?      | No. Campus Commander sends only the category change. Check L3 proves what Google does with the values before the build.                                             |

U4 answers the definition read of the open item at `docs/workflows/platform-access.md:701` for the Custom attributes tab.

## Defaults

The screen approval accepted four named defaults:

1. To confirm a removed attribute or a deleted category, the person types its name. Device actions type the action word, for example POWERWASH.
2. The category list drops the "Last changed" column of frame 01. Google records no change time for a category.
3. The design adds an optional range for number attributes, for example Grade level 0 to 12. States 13 to 15 of the [number range mockup](../ui/designs/2026-11-18-custom-attributes-ranges.html) draw it.
4. The Name column stays pinned at the left of the Users grid.

The other defaults are baseline section 7, document A section 15.4, and the engineering defaults of document B section 15.
They are engineering choices. The owner can change each one.

## Design

| Figma node | Name                          | Use                                                                 |
| ---------- | ----------------------------- | ------------------------------------------------------------------- |
| `291:2`    | 11 — User Management          | Start frame and frames 01 to 13 of the users mockup, in that order. |
| `291:3`    | 12 — Custom Attributes        | Start frame and frames 01 to 15 of the custom attributes mockups.   |
| `240:2`    | 10 — Users (September frames) | Content reference only. It predates the built shell.                |

Each Figma frame name carries the state number of its stored PNG.
States 13 to 15 close the design gap of default 3, the number range inputs. The owner approved them on 2026-11-18.
Slices S4 and S5 need their own screens.

## Exclusions and later slices

- Later slices: S4 account actions and S5 export and import. Each gets its own design addendum and screens (baseline section 6).
- Excluded: user creation and deletion, password handoff, licenses, alias editing, group membership (G21), admin roles, Classroom, and platform access.

## Preconditions and live checks

- admin-sdk-mock 0.4.0 adds the schemas resource and custom schema values. The owner approved its release on 2026-11-16.
- Live reads use `admin.directory.user.readonly` and `admin.directory.userschema.readonly`. The owner reported both scopes added on 2026-11-16.
- Live writes use `admin.directory.user` and `admin.directory.userschema`. The owner reported all four scopes added on 2026-11-16: "2) Added all four". A token exchange issued a token for each scope.
- Each live category write and each live user write needs a separate yes from the owner (`AGENTS.md`).

## Completion

Each slice completes when the owner sees it work on admin-sdk-mock and its live read-only check passes.

1. S1: browse users, filter on an attribute, select users, refresh, and open the details of one user. The owner signed off S1 on 2026-11-18.
2. S2: create, edit, and delete a category, and see each result in the dialog.
3. S3: set values on one user, in the grid, and through Bulk Actions, Set attributes, and see each outcome.
4. Live read-only check: `users.list` and `schemas.list` on the owner's domain.

The owner signs off each slice. Passing tests approve no screen.
