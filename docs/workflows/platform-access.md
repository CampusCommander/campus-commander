# Add a platform user and assign access

Status: proposed workflow with owner-confirmed decisions below. Implementation is not authorized.
Source: owner instructions in the platform-access discussion, 2026-09-17. Exact decision text appears below.
Design: missing. See the [Figma coverage record](../portfolio/prototype-map.md).
Replaces: conflicting interpretations of historical decision 17.7, manual copy-link delivery, and the implemented second administrator confirmation.

## User and outcome

An administrator adds a person to Campus Commander and assigns platform permissions and resource access.
Platform users use Campus Commander. Google Workspace accounts are records that Campus Commander manages.
Adding platform access does not create or modify a Google Workspace account.

## Owner-confirmed decisions

### Who administrators can invite — 2026-09-17

> The admin should be able to select from a google directory. They should be able to invite people from outside of the workspace. No one should be able to request access. This is an invite only platform.

- Administrators can select people from a Google directory.
- Administrators can invite people outside the connected Google Workspace.
- Campus Commander is invite-only.
- People cannot request access.

Recipient authentication remains unresolved. The activation decision below excludes a second administrator confirmation.
The external-person entry method remains open.

### Invitation delivery — 2026-09-17

The owner answered "1" to these options:

1. Email from Campus Commander — requires configured email delivery.
2. Copyable invitation link — the administrator shares it.
3. Both.

Campus Commander sends invitation emails. The selected delivery method requires configured email delivery.
Manual sharing of a copyable invitation link is outside this agreed workflow.
Email transport, provider configuration, invitation content, and delivery failure handling remain open.
Email delivery does not determine recipient authentication. The next decision defines access activation.
It supersedes the historical implementation's copyable invitation without SMTP as the intended delivery workflow.

### Access activation — 2026-09-17

The owner answered "1" to the question:

> After the recipient accepts and verifies their identity, when should access activate?

1. Immediately — recommended. The invitation already represents the administrator's approval.
2. After another administrator confirmation. The recipient waits for a second review.

Access activates immediately after the recipient accepts a valid invitation and verifies their identity.
No second administrator confirmation is required. The invitation represents the administrator's approval.
This decision replaces the implemented requirement for the inviter to confirm the recipient after identity verification.
It does not allow uninvited access or bypass invitation validity and authorization checks.
The identity verification method remains open. The permission model is recorded below.

### Permission assignment — 2026-09-17

The owner answered "1" to the question:

> How should administrators assign permissions to platform users?

1. Reusable roles. Define permissions in roles, then assign those roles to people.
2. Roles plus individual exceptions. Assign roles, then adjust permissions for specific people.
3. Individual permissions only. Configure each person's permissions separately.

Administrators define permissions in reusable roles and assign those roles to platform users.
Per-person permission exceptions and direct individual permission assignment are outside the agreed model.
Roles define permissions. The resource-access decision below defines the scope basis.
The complete permission catalog, built-in roles, and delegation authority remain open.
Historical presets do not establish the role catalog for this workflow.

### Resource access — 2026-09-17

The owner stated:

> Access is scoped by OrgUnits or a collection of OrgUnuits

Resource access is scoped by an OrgUnit or a collection of OrgUnits.
This establishes OrgUnits as the scope basis for the Google users and devices discussed in the preceding question.
It does not establish a separate school entity or authorize school creation.

The descendant-selection decision below defines the control for each selected OrgUnit.
Exclusions and the treatment of later OrgUnit changes remain open.
The collection and access-assignment decision below defines named reusable collections and their relationship to roles.
Group access and platform-wide administrative permissions require separate definitions.
This answer does not establish a separate whole-Workspace access option.

### Include descendants — 2026-09-17

The owner answered "3" to the question:

> Should access to an OrgUnit include its descendants?

1. Include all descendants. Covers existing descendants and those added later.
2. Selected OrgUnits only. Administrators explicitly select each accessible OrgUnit.
3. Administrator chooses per selection. Each selected OrgUnit has an "Include descendants" option.

Each selected OrgUnit has an "Include descendants" option controlled by the administrator.
When selected, that scope includes the selected OrgUnit and its descendants.
When cleared, that scope includes only the selected OrgUnit.
The administrator makes this choice separately for each OrgUnit in a collection.
The option's initial state and the treatment of later OrgUnit changes remain open.
Overlapping assignments follow the most-permissive rule below. Exclusions remain open.
Clearing this option does not establish an explicit denial rule.

### Roles, OrgUnit collections, and access assignments — 2026-09-17

The owner provided this example:

> A role is a collection of permissions. Like `devices-read`, `users-read`. Is saved as a role named `Librarian`s. A collection of orgUnits /devices/schools/smith/lib1, /devices/schools/smith/lib2 with a name like Smith Elementary. Note: An orgUnit collection is the best representation of a school in google workspace meta. Then you Make the Assignment, mSmith@school.edu is assigned Libraries and Smith Elementary. So Mrs. Smith can now read Devices and Users scoped by the orgUnit collection.

| Concept | Owner-confirmed meaning | Example |
| --- | --- | --- |
| Permission | An action available within an entity area. | `devices-read`, `users-read` |
| Role | A named reusable collection of permissions. | Librarians contains `devices-read` and `users-read`. |
| OrgUnit collection | A named reusable collection of OrgUnits defining resource scope. | Smith Elementary contains `/devices/schools/smith/lib1` and `/devices/schools/smith/lib2`. |
| Access assignment | The association of a platform user, a role, and an OrgUnit collection. | `mSmith@school.edu` receives Librarians scoped to Smith Elementary. |

The example uses "Librarians" consistently for the role called "Librarian`s" and "Libraries" in the owner's message.
These example names do not establish built-in roles or a fixed permission catalog.
"Access assignment" distinguishes this product relationship from the existing job-execution term "Assignment."

Mrs. Smith can read devices and Google users within the Smith Elementary OrgUnit collection.
That assignment does not authorize other actions or access outside its collection.
Each OrgUnit entry retains its own "Include descendants" option.
The example does not specify those option values or assert that the example OrgUnits contain Google users.

An OrgUnit collection represents a school for this access model. Its name does not create a separate school entity.
This decision replaces the historical school-scope interpretation that required an independent school identity.
Collection creation, editing, and assignment controls still need their own interface definition under Settings.
Multiple assignments, their overlap rule, and automatic application of saved changes are confirmed below.

### Multiple access assignments — 2026-09-17

The owner answered "1" to the question:

> Can a platform user have multiple access assignments?

1. Yes. Each assignment pairs a role with its own OrgUnit collection, allowing different responsibilities across collections.
2. No. Each platform user has one role-and-collection assignment.

A platform user can have multiple access assignments.
Each assignment pairs one role with its own OrgUnit collection.
The role's permissions apply within that assignment's collection, not automatically across the user's other collections.
For example, read access through one assignment does not transfer another assignment's editing permissions to that first collection.
This example describes separate scopes. Where collections overlap, the most-permissive rule below applies.

### Overlapping access assignments — 2026-09-17

The owner answered:

> 1) Most permissive wins

The question offered combining permissions or preventing overlapping assignments.
The owner selected combining permissions.

Overlapping access assignments are allowed. Most permissive wins within the overlap.
For a resource, combine the permissions from every applicable assignment whose OrgUnit collection includes that resource.
An assignment that lacks a permission does not cancel another applicable assignment that grants it.
Permissions remain paired with each assignment's OrgUnit collection. They do not extend into unrelated collections.

For example, read access from one assignment and edit access from another both apply within their shared scope.
Outside that overlap, each assignment grants only its own permissions within its own collection.
If no applicable assignment grants an action, the platform user lacks permission for that action on that resource.
This rule does not define collection exclusions or bypass invitation, identity, or account-authorization checks.

### Saved role and collection changes — 2026-09-17

The owner answered "1" to the question:

> When an administrator edits a saved role or OrgUnit collection, should existing assignments use the changes automatically?

1. Yes. Saving updates access for everyone assigned that role or collection.
2. No. Existing assignments retain their previous permissions and scope until explicitly updated.

Existing access assignments automatically use saved changes to their role or OrgUnit collection.
Saving a role updates its permissions for every assignment using that role.
Saving an OrgUnit collection updates resource scope for every assignment using that collection.
Assignments do not retain separate copies that require manual updates.
The most-permissive rule still applies when another assignment grants access to the same resource.

This decision covers edits to saved roles and collections within Campus Commander.
The treatment of later Google OrgUnit hierarchy changes remains open.
Effects on work already running remain part of the unresolved access-revocation workflow.

### Interface organization — 2026-09-17

The owner placed all platform settings under Settings and required a separate page for each concern.
[UI-11](../ui/rules.md#ui-11--settings-organization-and-visible-work) contains the canonical layout rules and the owner's named concerns.
Platform Users and Platform Roles and Permissions are separate concerns under Settings.
Exact controls for role definitions, OrgUnit collections, and access assignments remain open within this organization.

## Interaction

The workflow belongs to the Platform Users concern under Settings.
Administrators can select a directory account or invite someone outside the Workspace.
Campus Commander delivers the invitation by email.
The recipient accepts a valid invitation and verifies their identity. Access activates immediately without another administrator confirmation.
The exact entry controls, identity verification steps, success presentation, and return path remain open.

## Permissions and failures

Roles contain permissions. Named OrgUnit collections define resource scope.
An access assignment associates a platform user with a role and an OrgUnit collection.
A platform user can have multiple assignments. Each role remains paired with its assignment's collection.
Within overlapping scopes, permissions combine and most permissive wins.

Each selected OrgUnit has its own "Include descendants" option.
Saved role and collection changes automatically apply to every assignment using them.
The complete permission catalog, assignment controls, remaining scope behavior, and delegation authority remain open.

External sign-in requirements, identity matching, invitation failures, expiry, and repeat invitations remain open.
Retain application authorization and credential protection.
No access-request workflow is permitted.

## Examples

- A district administrator selects a staff member from the Google directory for platform access.
- A district administrator invites an external consultant who has no account in the connected Workspace.
- An invited person accepts a valid invitation and verifies their identity. Access activates without another administrator confirmation.
- An administrator assigns Librarians and Smith Elementary to `mSmith@school.edu`.
- That assignment permits device and Google user reads within the collection. It does not permit edits or out-of-scope reads.
- Overlapping read and edit assignments allow both actions within their shared scope.
- Outside the overlap, a read assignment does not gain editing permission from the other assignment.
- An administrator scopes resource access to one OrgUnit or a collection of OrgUnits.
- An administrator includes descendants for one selected OrgUnit and selects only another OrgUnit without its descendants.
- An uninvited person cannot request access. The exact sign-in message remains open.

These examples define eligibility, activation, reusable roles, and the OrgUnit scope basis.
Authentication details and scope behavior remain open.

## Exclusions and open decisions

Exclude Google account creation, school creation, and automatic access through an access request.
Do not change application code until the owner authorizes implementation.

Next decisions:

1. Access-assignment placement, remaining page interactions, and Figma compositions under Settings.
2. The permission catalog, remaining scope behavior, delegation authority, and group access.
3. External identity requirements and entry method.
4. Identity verification and remaining recipient steps.
5. Email configuration, invitation content, and delivery failure handling.

Resolve only decisions needed for this workflow. Other gaps remain attached to their own tasks.

## Completion

Record the agreed administrator and recipient interactions, permission assignment, resource access, and interface placement.
Record the normal outcome and material denied or failed outcomes.
Inspect relevant Figma compositions before authorized screen implementation. Current compositions are missing.
Applicable UI rules: UI-01, UI-03, UI-09, and UI-11.
Current validation covers documentation consistency only. No implementation, browser checks, or visual acceptance occurred.
