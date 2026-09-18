# Add a platform user and assign access

Status: proposed workflow with owner-confirmed decisions below. Implementation is not authorized.
Source: owner instructions in the platform-access discussion, 2026-09-17 through 2026-09-18. Exact decision text appears below.
Design: missing. See the [Figma coverage record](../portfolio/prototype-map.md).
Replaces: conflicting interpretations of historical decision 17.7, manual copy-link delivery, and the implemented second administrator confirmation.

## User and outcome

A Platform Admin adds a person to Campus Commander and assigns platform permissions and resource access.
Platform users use Campus Commander. Google Workspace accounts are records that Campus Commander manages.
Adding platform access does not create or modify a Google Workspace account.

## Owner-confirmed decisions

### Who administrators can invite — 2026-09-17

> The admin should be able to select from a google directory. They should be able to invite people from outside of the workspace. No one should be able to request access. This is an invite only platform.

- Administrators can select people from a Google directory.
- Administrators can invite people outside the connected Google Workspace.
- Campus Commander is invite-only.
- People cannot request access.

External sign-in methods and administrator control of allowed methods are defined below. Invitation acceptance requires verification of the invited email address, as confirmed below.
The activation decision below excludes a second administrator confirmation.
External email entry and recipient review are confirmed below.

### Multiple directory invitees — 2026-09-18

The owner answered "1" to the question:

> For Google directory selection, should Platform Admin invite multiple people at once?

1. Yes. Select multiple people in a searchable directory grid and send their invitations together.
2. One person at a time. Repeat directory selection for each invitation.

Platform Admin selects one or more people in a searchable Google directory grid from Settings > Platform Users.
The administrator can send invitations to the selected people together without repeating directory selection for each person.
Each recipient accepts their own invitation and verifies their invited email address before their platform access activates.
Selection grants no platform access and does not change the selected Google Workspace accounts.
Role and resource assignments remain on the separate Access Assignments page.
Exact controls and the Figma composition remain open.

### External invitee entry — 2026-09-18

The owner answered "1" to the question:

> How should Platform Admin enter external invitees?

1. Enter or paste one or more email addresses. Review the recipients before sending invitations together.
2. One email address at a time. Send each invitation separately.

From Settings > Platform Users, Platform Admin enters or pastes one or more external email addresses.
The administrator reviews the recipients before sending their invitations together.
Each recipient accepts their own invitation and verifies the invited email address before platform access activates.
External invitees do not need Google accounts. Allowed sign-in methods remain controlled per platform user.
Role and resource assignments remain on the separate Access Assignments page.
Invalid addresses must be corrected or removed before sending, as confirmed below.
Exact controls, validation message presentation, and the Figma composition remain open.

### Invalid recipient addresses — 2026-09-18

The owner answered "1" to the question:

> If recipient review finds an invalid email address, what should happen?

1. Require correction or removal before sending. The administrator resolves the recipient list first.
2. Send to valid addresses only. Show which addresses were skipped and why.

If recipient review finds an invalid email address, sending is blocked for the selected recipients.
Platform Admin must correct or remove each invalid address before sending any invitations in that selection.
The application does not send only to the valid addresses while invalid addresses remain in the selection.
This rule concerns validation before sending. Delivery failures after sending remain a separate unresolved behavior.
Exact validation message presentation remains a design requirement.

### External invitees without Google accounts — 2026-09-17

The owner answered "2" to the question:

> Must external invitees have a Google account?

1. Yes. Use Google sign-in for both district staff and external invitees.
2. No. Support invitees without Google accounts, with their sign-in method defined next.

External invitees do not need a Google account.
Campus Commander must support invited platform users who have no Google account.
The platform remains invite-only. Acceptance and identity verification still precede access activation.
The external sign-in decision below defines the supported methods.

### External sign-in methods — 2026-09-17

The owner answered "1,3" to the question:

> How should these invitees sign in?

1. Configured identity providers. Use Microsoft or another configured provider.
2. Email and password. Campus Commander manages their credentials and password recovery.
3. Email sign-in codes. Campus Commander emails a one-time code for each sign-in.

Support both configured identity providers and email sign-in codes for external invitees.
For email-code sign-in, Campus Commander emails a one-time code for each sign-in.
Campus Commander-managed passwords and password recovery are outside the selected model.
The provider examples do not establish the complete provider catalog.

These methods authenticate invited platform users. They do not allow self-registration or access requests.
Invitation acceptance and identity verification still precede immediate access activation.
Administrators control allowed methods for each platform user, as confirmed below. Invitation acceptance requires verification of the invited email address, as confirmed below.
Provider configuration, email-code delivery failures, and recovery interactions remain open.

### Allowed sign-in methods per platform user — 2026-09-17

The owner answered "1" to the question:

> Who controls which sign-in methods a platform user can use?

1. Administrator selects allowed methods per platform user. Supports provider-only access where required.
2. The platform user chooses either enabled method. No restrictions per platform user.

An administrator selects the allowed sign-in methods for each platform user.
The platform user can sign in only through an allowed method.
Email-code sign-in does not provide an alternative when the administrator permits only provider sign-in.
If the administrator permits both methods, either method is available to that platform user.

This is a platform-user setting. Installation-wide identity-provider configuration remains a separate Provider settings concern.
Initial methods are selected separately for each recipient before sending, as confirmed below.
Exact provider-selection controls and effects of method changes on active sessions remain open.
The invited-email verification rule is confirmed below. Recovery interactions remain open.

### Sign-in selection before sending — 2026-09-18

The owner answered "2" to the question:

> When inviting several people, how should Platform Admin select their allowed sign-in methods?

1. Choose once for the selected recipients. Apply those methods to each person, with individual editing available afterward.
2. Choose separately for every recipient before sending invitations.

Platform Admin selects allowed sign-in methods separately for every recipient before sending invitations.
This applies to directory selections and external email entry, including invitations sent together.
A single shared selection for all recipients does not replace this individual selection.
Different recipients can have different allowed methods within the same invitation operation.
These choices belong to Platform Users. Provider configuration remains on its separate Settings page.
Exact controls and the Figma composition remain open.

### Invited email verification — 2026-09-17

The owner answered "yes." to the question:

> Must the recipient verify the same email address that received the invitation?

Acceptance requires verification of the invited email address through a sign-in method allowed for that platform user.
For provider sign-in, the verified email address must match the invited address.
For email-code sign-in, the recipient verifies the invited address using the code delivered to that address.
A different verified email address cannot accept the invitation.
An unverified email assertion does not satisfy this requirement.

For example, an invitation to `mSmith@school.edu` cannot be accepted using a different verified address.
A forwarded invitation does not transfer eligibility to its recipient's own address.
This rule defines invitation acceptance. Later identity changes and account recovery still need their applicable workflow rules.

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

### Pending invitation actions — 2026-09-18

The owner answered "1" to the question:

> How should Platform Admin manage pending invitations from Settings > Platform Users?

1. Resend and revoke. Resend the invitation email or cancel acceptance.
2. Revoke and create again. Cancel the existing invitation and repeat the invitation process when needed.

Platform Admin can resend or revoke a pending invitation from Settings > Platform Users.
Resend sends another invitation email to the invited address without requiring the administrator to repeat the invitation process.
Revoke prevents acceptance of that invitation. It cannot activate platform access after revocation.
These actions concern pending invitations. They do not define suspension or removal of an active platform user.
The invitation validity period is seven days. Resend restarts that period, as confirmed below. Delivery failure handling remains open.

### Invitation validity period — 2026-09-18

The owner answered "1" to the question:

> How long should an invitation remain valid?

1. Seven days. Gives recipients time to respond while limiting outstanding invitations.
2. 24 hours. Requires recipients to respond sooner.
3. Administrator-configurable, with seven days as the default under Platform Settings.

An invitation remains valid for seven days unless accepted or revoked earlier.
An expired invitation cannot activate platform access.
The selected duration is fixed. An administrator-configurable duration is outside the agreed workflow.
Resend restarts the seven-day period, as confirmed below.

### Resend restarts invitation validity — 2026-09-18

The owner answered "1" to the question:

> Should Resend restart the seven-day period?

1. Yes. Give the recipient seven days from the resend.
2. No. Keep the original expiration time.

Resend gives the recipient seven days from the resend to accept the invitation.
It replaces the original expiration time with that new deadline.
Resend does not activate access. The recipient must still accept and verify the invited email address.
Resend also applies to expired invitations, as confirmed below. Invitations after revocation remain open.

### Resend expired invitations — 2026-09-18

The owner answered "1" to the question:

> Should Platform Admin also use Resend for an expired invitation?

1. Yes. Send another invitation email with a fresh seven-day period.
2. No. Require a new invitation through the add-person process.

Platform Admin can use Resend for an expired invitation from Settings > Platform Users.
Campus Commander sends another invitation email with a fresh seven-day validity period.
The administrator does not repeat the add-person process.
The recipient must still accept the invitation and verify the invited email address before access activates.
This decision does not authorize resending revoked invitations.

### Access activation — 2026-09-17

The owner answered "1" to the question:

> After the recipient accepts and verifies their identity, when should access activate?

1. Immediately — recommended. The invitation already represents the administrator's approval.
2. After another administrator confirmation. The recipient waits for a second review.

Access activates immediately after the recipient accepts a valid invitation and verifies their identity.
No second administrator confirmation is required. The invitation represents the administrator's approval.
This decision replaces the implemented requirement for the inviter to confirm the recipient after identity verification.
It does not allow uninvited access or bypass invitation validity and authorization checks.
The supported external sign-in methods and invited-email verification rule are defined above.
The permission model is recorded below.

### Assignments for pending invitees — 2026-09-17

The owner answered "1" to the question:

> Can administrators create access assignments while someone's invitation is pending?

1. Yes. Configure assignments on Access Assignments before acceptance. They take effect after acceptance and identity verification.
2. No. Create assignments only after the person accepts.

Administrators can create access assignments for pending invitees on Settings > Access Assignments.
These assignments grant no access before invitation acceptance and identity verification.
After acceptance and identity verification, the assignments take effect without a second administrator confirmation.
This permits advance assignment. It does not require assignments before acceptance.
Platform Users continues to handle invitations. Assignment management remains on its separate page.

### Permission assignment — 2026-09-17

The owner answered "1" to the question:

> How should administrators assign permissions to platform users?

1. Reusable roles. Define permissions in roles, then assign those roles to people.
2. Roles plus individual exceptions. Assign roles, then adjust permissions for specific people.
3. Individual permissions only. Configure each person's permissions separately.

Administrators define permissions in reusable roles and assign those roles to platform users.
Per-person permission exceptions and direct individual permission assignment are outside the agreed model.
Roles define permissions. The resource-access decision below defines the scope basis.
Granular permissions, Asset Super Admin, and Platform Admin assignment authority are confirmed below.
The remaining catalog and other built-in roles remain open. Platform Admin-only access administration is confirmed below.
Historical presets do not establish the role catalog for this workflow.

### Platform Admin and Asset Super Admin — 2026-09-17

The owner answered the question about automatic full Google resource access for platform administrators:

> Yes. But it is a special built in Role, Asset Super Admin. Since platform admin can give any person any role they have defacto Asset Super Admin access. Giving it the built in role just makes it formal and unambiguous that Asset Admin work is different from Platform Admin work.

Asset Super Admin is a special built-in role representing full access to managed Google resources across the connected Workspace.
Platform Admin has full asset access, formally represented by Asset Super Admin.
Platform administration and asset administration remain distinct responsibilities and must remain explicit in the role model.
Asset Super Admin represents asset administration. It does not itself grant Platform Admin authority.

Platform Admin can assign any role to any platform user, including themselves.
That authority includes assigning Asset Super Admin and is not limited by the administrator's existing asset assignments.
The owner recognizes this assignment authority as de facto Asset Super Admin access.
Do not describe Platform Admin as isolated from asset authority merely because the two responsibilities have different names.

These are Campus Commander authorities. They do not confer a Google Workspace Super Admin role on the person's Google account.
Ordinary asset roles retain their OrgUnit-collection scopes. Asset Super Admin represents full asset access.
The exact grant presentation for the built-in role remains to be designed.
The access-administration decision below defines who manages access. The remaining built-in role catalog remains open.

### Access administration authority — 2026-09-18

The owner answered "1" to the question:

> Who can manage platform users, roles, OrgUnit collections, and access assignments?

1. Platform Admin only. Keeps access administration centralized for the initial workflow.
2. Delegated administrators too. Separate platform permissions let other roles manage selected administrative concerns.

Only Platform Admin manages platform users, roles, OrgUnit collections, and access assignments in the initial workflow.
This includes invitations and each platform user's allowed sign-in methods.
Asset Super Admin alone does not grant this authority.
Delegated access administration is outside the initial workflow. It is not approved or a prerequisite for implementation.
These concerns retain their separate pages under Settings.

### Granular permissions — 2026-09-17

The owner stated:

> Granular. Device Read, Device Write, Device Deprecate, Device Bulk Actions, User Read, User Write , User schema manage, User Bulk Actions, etc

Roles contain separately selectable granular permissions.
The owner named these initial permissions:

| Entity area | Permission labels |
| --- | --- |
| Devices | Device Read, Device Write, Device Deprovision, Device Bulk Actions |
| Google users | User Read, User Write, User Schema Manage, User Bulk Actions |

These are distinct permission choices. A single broad "Manage devices" or "Manage users" permission does not replace them.
The list is illustrative, not a complete catalog. Exact action coverage and dependencies require definition before dependent implementation.
Do not assume Write includes Deprovision, schema management, or bulk actions.
Bulk Actions and action-specific permissions work together as confirmed below.

The owner clarified the terminology and scope of the examples:

> Deprovision yea. But like you said this is not a exhaustive list

Use "Device Deprovision" for the existing [Deprovision action](../portfolio/02-domain-model.md#devices-chromeos).
This replaces "Device Deprecate" in the permission labels. The original quotation remains above for provenance.
The owner explicitly confirmed that the list is non-exhaustive.
Define additional permissions as their workflows require them. Do not require the entire catalog before progress.

User Schema Manage is confirmed as a distinct permission. Its schema-definition and field-value boundaries remain open.
These permissions concern managed Google resources. Platform administration permissions remain a separate part of the catalog.

### Bulk Actions permission — 2026-09-17

The owner answered yes to requiring both the action permission and the corresponding Bulk Actions permission:

> Yes. Bulk actions gives access to the Bulk Actions menu dropdown button. Further permissions show which features are enabled in that dropdown.

The entity's Bulk Actions permission controls access to its Bulk Actions dropdown button.
Action-specific permissions determine which features are enabled inside the dropdown.
A bulk operation requires both the entity's Bulk Actions permission and the permission for that operation within the applicable scope.
Bulk Actions alone does not grant the underlying operations.
An action permission alone does not grant access to the Bulk Actions dropdown.

For example, bulk deprovisioning requires Device Bulk Actions and Device Deprovision for the applicable resource scope.
A user with Device Bulk Actions but without Device Deprovision cannot execute deprovisioning from that dropdown.
An action remains subject to its selection, eligibility, and provider requirements.
The permission requirements apply to authorization, not only to the visual state of the menu.

[GRID-06](../ui/patterns.md#entity-grid) records the reusable UI rule.
Existing GRID-01 guidance keeps supported menu items visible and disables unavailable actions with an explanation.
The exact button state without Bulk Actions permission remains a design detail to resolve against Figma.

### Resource access — 2026-09-17

The owner stated:

> Access is scoped by OrgUnits or a collection of OrgUnuits

Resource access is scoped by an OrgUnit or a collection of OrgUnits.
This establishes OrgUnits as the scope basis for the Google users and devices discussed in the preceding question.
It does not establish a separate school entity or authorize school creation.

The descendant-selection decision below defines the control for each selected OrgUnit.
Exclusions remain open. Descendant scope follows the current hierarchy as confirmed below.
The collection and access-assignment decision below defines named reusable collections and their relationship to roles.
Ordinary group access and the detailed platform permission catalog require separate definitions.
Asset Super Admin provides full asset access as confirmed above. Ordinary role assignments remain scoped by OrgUnit collections.

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
The option defaults to off when adding an OrgUnit, as confirmed below.

Overlapping assignments follow the most-permissive rule below. Exclusions remain open.
Clearing this option does not establish an explicit denial rule.

### Include descendants default — 2026-09-18

The owner answered "1" to the question:

> For resource access, when adding an OrgUnit to a collection, should Include descendants start off or on?

1. Off. Include only the selected OrgUnit until the administrator enables descendants.
2. On. Include the selected OrgUnit and its descendants unless the administrator disables it.

"Include descendants" defaults to off for each OrgUnit added to a collection.
That entry includes only the selected OrgUnit until Platform Admin explicitly enables descendants for it.
The choice remains independent for each entry. Enabling it follows the current Google hierarchy as confirmed below.
This default does not change saved choices or deny access granted through another applicable assignment.

### Descendant hierarchy changes — 2026-09-17

The owner answered "1" to the question:

> When "Include descendants" is enabled, should access follow changes to the Google OrgUnit hierarchy?

1. Follow the current hierarchy. New or moved-in descendants become included. Moved-out descendants leave that scope.
2. Keep the descendants selected when saved. Administrators explicitly update the collection to include later hierarchy changes.

When "Include descendants" is enabled, the scope follows the current Google OrgUnit hierarchy.
New or moved-in descendants enter that scope. Descendants moved outside the selected OrgUnit leave that scope.
Administrators do not need to save the collection again to apply those hierarchy changes.
A platform user retains access to a moved-out OrgUnit if another applicable assignment grants it.

This decision replaces a fixed snapshot of descendants for this access workflow.
It does not define provider refresh timing or the effects on work already running.

### Roles, OrgUnit collections, and access assignments — 2026-09-17

The owner provided this example:

> A role is a collection of permissions. Like `devices-read`, `users-read`. Is saved as a role named `Librarian`s. A collection of orgUnits /devices/schools/smith/lib1, /devices/schools/smith/lib2 with a name like Smith Elementary. Note: An orgUnit collection is the best representation of a school in google workspace meta. Then you Make the Assignment, mSmith@school.edu is assigned Libraries and Smith Elementary. So Mrs. Smith can now read Devices and Users scoped by the orgUnit collection.

| Concept | Owner-confirmed meaning | Example |
| --- | --- | --- |
| Permission | An action available within an entity area. | `devices-read`, `users-read` |
| Role | A named reusable collection of permissions. | Librarians contains `devices-read` and `users-read`. |
| OrgUnit collection | A named reusable collection of OrgUnits defining resource scope. | Smith Elementary contains `/devices/schools/smith/lib1` and `/devices/schools/smith/lib2`. |
| Access assignment | For ordinary asset roles, the association of a platform user, a role, and an OrgUnit collection. | `mSmith@school.edu` receives Librarians scoped to Smith Elementary. |

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
Each ordinary asset assignment pairs one role with its own OrgUnit collection.
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
The descendant-hierarchy decision above covers changes to the Google OrgUnit hierarchy.
Effects on work already running remain part of the unresolved access-revocation workflow.

### Interface organization — 2026-09-17

The owner placed all platform settings under Settings and required a separate page for each concern.
[UI-11](../ui/rules.md#ui-11--settings-organization-and-visible-work) contains the canonical layout rules and the owner's named concerns.
The owner selected a separate Access Assignments page and reiterated:

> 1. Separate Concerns get their own page. Do Not Mix concerns.

Access Assignments has its own page under Settings.
Its grid lists the platform user, role, and OrgUnit collection for each assignment.
Do not place assignment management inside Platform Users details or an assignments tab on that page.

Apply the owner's one-page-per-concern rule to the established access model:

| Settings page | Concern |
| --- | --- |
| Platform Users | Platform users and invitations. |
| Platform Roles and Permissions | Role definitions and their permissions. |
| OrgUnit Collections | Named collections of OrgUnits and each entry's descendant option. |
| Access Assignments | Assignments connecting platform users, roles, and OrgUnit collections. |

These pages remain separate. Tabs organize content within one concern, not multiple concerns on one page.
Do not reopen this separation as a product choice in later design questions.
Exact controls, navigation order, and Figma compositions remain open.

## Interaction

Platform Admin adds platform users through Settings > Platform Users.
Administrators manage assignments through Settings > Access Assignments.
Role definitions and OrgUnit collections have their own Settings pages.

Platform Admin can select one or more people in a searchable Google directory grid and send their invitations together.
For external invitees, Platform Admin enters or pastes one or more email addresses and reviews the recipients before sending.
Before sending, Platform Admin corrects or removes invalid email addresses and selects allowed sign-in methods separately for each recipient.
Campus Commander delivers the invitation by email.
Platform Admin can resend pending or expired invitations on Platform Users. Resend starts a fresh seven-day validity period.
Platform Admin can revoke pending invitations on that page.
While the invitation is pending, an administrator can configure assignments on the separate Access Assignments page.
The recipient accepts a valid invitation and verifies their identity. Access activates immediately without another administrator confirmation.
Previously configured assignments take effect after acceptance and identity verification.

The exact entry controls, identity verification steps, success presentation, and return path remain open.

## Permissions and failures

Roles contain permissions. Named OrgUnit collections define resource scope.
An ordinary asset access assignment associates a platform user with a role and an OrgUnit collection.
A platform user can have multiple assignments. Each role remains paired with its assignment's collection.
Within overlapping scopes, permissions combine and most permissive wins.

Each selected OrgUnit has its own "Include descendants" option, which defaults to off when added to a collection.
When enabled, it follows the current Google hierarchy.
Saved role and collection changes automatically apply to every assignment using them.
Roles use granular permissions, including the owner's initial device and Google-user examples.
Bulk operations require both Bulk Actions and the action-specific permission within the applicable scope.
The remaining catalog, other permission dependencies, exact controls, and scope behavior remain open.

Only Platform Admin manages platform users, roles, OrgUnit collections, and access assignments in the initial workflow.
Platform Admin can assign any role to any platform user, including Asset Super Admin.
Asset Super Admin formally represents full Google resource access and remains distinct from platform administration.

External invitees do not need Google accounts. Configured identity providers and email sign-in codes are supported.
Administrators select allowed methods per platform user. Invitation acceptance requires verification of the invited email address.
Invitations have a seven-day validity period. Expired or revoked invitations cannot activate access.
Resend starts a fresh seven-day validity period for pending or expired invitations.
Invalid recipient addresses block sending until Platform Admin corrects or removes them.
Delivery failures and invitations after revocation remain open.
Retain application authorization and credential protection.
No access-request workflow is permitted.

## Examples

- Platform Admin selects three staff members in the searchable Google directory grid and sends their invitations together.
- Each selected staff member must accept and verify their invited email address before their own access activates.
- Platform Admin pastes two external email addresses and reviews the recipients.
- If one address is invalid, no invitations in that selection are sent until it is corrected or removed.
- Before sending together, Platform Admin permits provider sign-in for one recipient and email codes for the other.
- An external consultant without a Google account accepts through an allowed sign-in method.
- Platform Admin resends a pending invitation from Platform Users. Campus Commander sends another invitation email.
- The consultant accepts the invitation and verifies identity through a sign-in method allowed by the administrator.
- A platform user restricted to provider sign-in cannot sign in through an email code.
- A recipient using a different verified email address cannot accept the invitation.
- Platform Admin revokes a pending invitation. The recipient cannot accept it to activate access.
- An invitation expires after seven days without a resend. The recipient cannot use it to activate access.
- Platform Admin resends an expired invitation. The recipient receives another email and has seven days to accept.
- Platform Admin resends an invitation two days before expiry. The recipient now has seven days from that resend.
- An invited person accepts a valid invitation and verifies their identity. Access activates without another administrator confirmation.
- While the invitation is pending, an administrator assigns Librarians and Smith Elementary to `mSmith@school.edu`.
- The assignment grants no access until the recipient accepts and verifies their identity.
- That assignment permits device and Google user reads within the collection. It does not permit edits or out-of-scope reads.
- Overlapping read and edit assignments allow both actions within their shared scope.
- Outside the overlap, a read assignment does not gain editing permission from the other assignment.
- Device Bulk Actions enables access to the dropdown. Device Deprovision additionally permits its deprovision feature.
- Device Bulk Actions without Device Deprovision does not permit bulk deprovisioning.
- An administrator scopes resource access to one OrgUnit or a collection of OrgUnits.
- Platform Admin adds an OrgUnit to a collection. Include descendants starts off, so the entry includes only that OrgUnit.
- An administrator includes descendants for one selected OrgUnit and selects only another OrgUnit without its descendants.
- A new descendant enters an enabled descendant scope. A moved-out descendant leaves that scope.
- Another applicable assignment still grants access to a moved-out OrgUnit according to the most-permissive rule.
- A Platform Admin can assign Asset Super Admin to another platform user or to themselves.
- Asset Super Admin gives full managed Google resource access without itself granting platform administration authority.
- A platform user without Platform Admin cannot invite people or edit roles, OrgUnit collections, or access assignments.
- An uninvited person cannot request access. The exact sign-in message remains open.

These examples define eligibility, activation, reusable roles, and the OrgUnit scope basis.
Authentication details and scope behavior remain open.

## Exclusions and open decisions

Exclude Google account creation, school creation, and automatic access through an access request.
Do not change application code until the owner authorizes implementation.

Next decisions:

1. Remaining page interactions and Figma compositions within the confirmed separate Settings pages.
2. Remaining action coverage, dependencies, catalog, scope behavior, and ordinary group access.
3. Sign-in method controls, validation message presentation, and identity-change recovery.
4. Identity verification and remaining recipient steps.
5. Email configuration, invitation content, invitations after revocation, and delivery failure handling.

Resolve only decisions needed for this workflow. Other gaps remain attached to their own tasks.

## Completion

Record the agreed administrator and recipient interactions, permission assignment, resource access, and interface placement.
Record the normal outcome and material denied or failed outcomes.
Inspect relevant Figma compositions before authorized screen implementation. Current compositions are missing.
Applicable UI rules: UI-01, UI-03, UI-09, UI-11, GRID-01, and GRID-06.
Current validation covers documentation consistency only. No implementation, browser checks, or visual acceptance occurred.
