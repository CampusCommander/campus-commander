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
This rule concerns validation before sending. [Undelivered invitations stay pending](#invitation-delivery-failures--2026-10-05).
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
Provider configuration and email-code delivery failures remain open. [Account recovery](#account-recovery--2026-10-05) is confirmed below.

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
Exact provider-selection controls remain open. [Removed methods end their active sessions](#removed-sign-in-methods--2026-10-05).
The invited-email verification rule is confirmed below. [Account recovery](#account-recovery--2026-10-05) is confirmed below.

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

### Removed sign-in methods — 2026-10-05

The owner answered "End it now" to the question:

> If Platform Admin removes a sign-in method from a platform user who is currently signed in through that method, what happens to their session?

1. End it now. Sessions created through the removed method end at once. The person must sign in again through a method that is still allowed.
2. Keep until it expires. The current session continues. The change applies the next time the person signs in.

Removing an allowed sign-in method immediately ends that platform user's sessions created through that method.
The platform user signs in again through a method that remains allowed.
Sessions created through a method that remains allowed continue.

For example, Platform Admin removes email-code sign-in from a consultant who signed in through an email code.
That session ends at once. The consultant signs in again through provider sign-in.
Every platform user keeps at least one allowed method, as confirmed below.

### At least one sign-in method — 2026-10-05

The owner answered "Block it" to the question:

> Can Platform Admin remove every allowed sign-in method from a platform user?

1. Block it. Every platform user keeps at least one allowed method. To stop access, Platform Admin uses the separate disable or remove action.
2. Allow it. Their sessions end, and they cannot sign in until a method is added back. Their account and access assignments stay in place.

Every platform user keeps at least one allowed sign-in method.
Campus Commander blocks removal of a platform user's last allowed method.
Platform Admin can replace that method by adding another allowed method first.
To stop a platform user's access, Platform Admin uses the separate disable or remove action.
That action belongs to the [remove access workflow](../workflow-gaps.md#decisions-needed-for-access-and-setup) (G08), which remains open.
The blocked-removal presentation remains a design requirement.

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
This rule defines invitation acceptance. [Platform Admin updates a changed email address](#email-address-changes--2026-10-05). [Platform Admin restores lost sign-in access](#account-recovery--2026-10-05).

### Email address changes — 2026-10-05

The owner answered "Admin updates it" to the question:

> When a platform user's email address changes (for example, a rename in Google Workspace after a name change), how do they keep their access?

1. Admin updates it. Platform Admin changes the address on Platform Users. The person verifies the new address before it takes effect. Sign-in methods and access assignments stay the same.
2. Follow Google for directory users. A rename in Google carries over automatically. External users still need an administrator update and verification.
3. Invite the new address. Treat the new address as a new person, recreate the assignments, and remove the old platform user.

Platform Admin changes a platform user's email address on Settings > Platform Users.
The platform user verifies the new address through an allowed sign-in method before the change takes effect.
Verification follows the [invited email verification rule](#invited-email-verification--2026-09-17) for the new address.
The platform user keeps the same allowed sign-in methods and access assignments.
This rule applies to directory-selected and external platform users.
Campus Commander does not follow Google Workspace renames automatically.
[The former address stops working when the change is saved](#former-address-after-a-change--2026-10-05).

### Former address after a change — 2026-10-05

The owner answered "Old address stops now" to the question:

> After Platform Admin changes someone's address, but before they verify the new one, can they still sign in with the old address?

1. Old address stops now. Sessions under the old address end at once. The next sign-in uses the new address and completes verification.
2. Old address works until verified. The person keeps signing in with the old address until they verify the new one.

When Platform Admin saves an email address change, the former address stops working at once.
Campus Commander ends that platform user's sessions under the former address.
The next sign-in uses the new address through an allowed sign-in method.
That sign-in verifies the new address and completes the change.
The former address cannot sign in or verify while the change waits for verification.

### Account recovery — 2026-10-05

The owner answered "Admin restores; operator fallback" to the question:

> If a platform user cannot sign in through any allowed method (for example, they lost access to their mailbox or provider account), how do they get back in?

1. Admin restores; operator fallback. No self-service recovery. Platform Admin changes the address or sign-in methods on Platform Users. If the only Platform Admin is locked out, a server operator uses the existing operator-credential recovery.
2. Admin restores only. No server-side fallback. Losing the only Platform Admin requires a fresh installation or another Platform Admin.
3. Require two Platform Admins. Each Platform Admin can recover the other. No operator fallback.

Campus Commander provides no self-service account recovery.
A platform user who cannot sign in contacts a Platform Admin.
Platform Admin restores access on Settings > Platform Users by changing the email address or allowed sign-in methods.
Those changes follow the [email address change](#email-address-changes--2026-10-05) and [sign-in method](#allowed-sign-in-methods-per-platform-user--2026-09-17) rules.
If no Platform Admin can sign in, a server operator restores a Platform Admin through operator-credential recovery.
The [access runbook](../../deployment/bootstrap/APPLICATION-ACCESS.md#revoke-and-recover-access) describes the existing operator recovery mechanism.
Campus Commander does not require a second Platform Admin.
The sign-in page message for a person who cannot sign in remains open with [G09](../workflow-gaps.md#decisions-needed-for-access-and-setup).

### Invitation delivery — 2026-09-17

The owner answered "1" to these options:

1. Email from Campus Commander — requires configured email delivery.
2. Copyable invitation link — the administrator shares it.
3. Both.

Campus Commander sends invitation emails. The selected delivery method requires configured email delivery.
[Campus Commander sends email through the connected Google Workspace](#email-delivery-through-google-workspace--2026-10-05).
Manual sharing of a copyable invitation link is outside this agreed workflow.
Email transport, provider configuration, and invitation content remain open. [Undelivered invitations stay pending](#invitation-delivery-failures--2026-10-05).
Email delivery does not determine recipient authentication. The next decision defines access activation.
It supersedes the historical implementation's copyable invitation without SMTP as the intended delivery workflow.

### Invitation delivery failures — 2026-10-05

The owner answered "Stays pending, flagged" to the question:

> If Campus Commander cannot deliver an invitation email (for example, the mail server rejects it), what happens to that invitation?

1. Stays pending, flagged. The invitation stays pending with a delivery-failed status on Platform Users. Platform Admin can fix the cause and resend, or revoke. Assignments configured in advance stay in place.
2. Cancelled automatically. Campus Commander cancels the invitation and notifies Platform Admin, who sends a new invitation.

An undelivered invitation stays pending.
Platform Users shows a delivery-failed status for that invitation.
Platform Admin can correct the cause and use Resend, or revoke the invitation.
Assignments configured for that invitee stay in place while the invitation remains pending.
Campus Commander does not cancel an invitation because of a delivery failure.
Failure detection, status wording, and other notification remain open.

### Email delivery through Google Workspace — 2026-10-05

The owner answered "Through Google Workspace" to the question:

> How should Campus Commander send its email (invitations and one-time sign-in codes)?

1. SMTP server. Platform Admin enters SMTP server details on a Settings page. It does not depend on the Google connection.
2. Through Google Workspace. Send through the connected Workspace with the Gmail API. This requires a Gmail send permission, which can send as any user in the domain.
3. Either, admin chooses. Support both. Platform Admin selects one on the email settings page.

Campus Commander sends invitation emails and email sign-in codes through the connected Google Workspace.
It uses the Gmail API through the existing domain-wide delegation connection.
This requires the `https://www.googleapis.com/auth/gmail.send` scope in the delegation configuration.
That scope permits sending as any user in the domain. Campus Commander sends only its own invitation and sign-in email.
SMTP configuration is outside the agreed workflow.

Invitation sending and email sign-in codes depend on a connected Workspace with that scope.
The [current read-only test authorization](../portfolio/phase-3-google-credentials.md#standing-test-authorization--2026-09-17) does not include this scope or sending email.
Live sending tests require the scope configuration and separate owner authorization.
[Platform Admin selects the sender mailbox](#sender-mailbox--2026-10-05). [Missing email setup blocks invitation sending](#sending-without-email-setup--2026-10-05). The sender name remains open.

### Sender mailbox — 2026-10-05

The owner answered "Admin-chosen mailbox" to the question:

> Which Workspace mailbox should Campus Commander send its email from?

1. Admin-chosen mailbox. Platform Admin selects one address in the domain. Every invitation and sign-in code comes from that address.
2. Inviting admin's address. Each invitation comes from the Platform Admin who sent it. Sign-in codes still need a separate fixed address.
3. Connection's admin account. Use the delegated administrator account of the Google connection.

Platform Admin selects one sender mailbox in the connected domain.
Campus Commander sends every invitation email and email sign-in code from that mailbox.
The sender mailbox is separate from the delegated administrator account of the Google connection.
Invitations do not come from the address of the inviting Platform Admin.
[Platform Settings holds this selection](#sender-mailbox-placement--2026-10-05). The sender name remains open. [Invitation sending stays blocked until selection](#sending-without-email-setup--2026-10-05).

### Sender mailbox placement — 2026-10-05

The owner answered "Platform Settings" to the question:

> Which Settings page should hold the sender mailbox setting?

1. Its own Email page. A separate Settings > Email page that later also holds the sender name and invitation content.
2. Provider settings. Place it with the Google connection, which carries the Gmail send scope.
3. Platform Settings. Treat it as general platform configuration, alongside the platform display name.

Platform Admin selects the sender mailbox on Settings > Platform Settings.
Provider settings keeps the Google connection and its scopes. It does not hold the sender mailbox.
No separate Email page exists in the agreed workflow.
Placement of the sender name and invitation content remains open.

### Sending without email setup — 2026-10-05

The owner answered "Block sending" to the question:

> If email is not ready (no Gmail send scope, or no sender mailbox selected), what happens when Platform Admin tries to send invitations?

1. Block sending. Platform Users explains that email is not set up and names the missing item. No invitations are created until email works.
2. Create them as failed. The invitations appear as pending with a delivery-failed status. Platform Admin resends them once email works.

Campus Commander blocks invitation sending until email setup is complete.
Email setup requires the Gmail send scope on Provider settings and a sender mailbox on Platform Settings.
Platform Users explains that email is not set up and names each missing item.
Campus Commander creates no invitations while sending is blocked.
The [delivery-failed status](#invitation-delivery-failures--2026-10-05) applies to failures after a send attempt, not to missing setup.
[Email sign-in codes show a sign-in message without email setup](#email-sign-in-codes-without-email-setup--2026-10-05).

### Email sign-in codes without email setup — 2026-10-05

The owner answered "Sign-in message only" to the question:

> If email stops working (scope removed or no sender mailbox), people allowed only email sign-in codes cannot sign in. What should happen?

1. Message plus admin warning. The sign-in page says that codes are unavailable. Platform Admin also sees a warning with the number of affected platform users.
2. Sign-in message only. The sign-in page says that codes are unavailable and directs the person to an administrator.

Without email setup, Campus Commander cannot send email sign-in codes.
The sign-in page tells the platform user that codes are unavailable and directs them to an administrator.
A platform user allowed only email sign-in codes cannot sign in until email setup is complete.
A platform user also allowed provider sign-in can still sign in through that provider.
Campus Commander shows administrators no separate warning about affected platform users.
The exact message wording remains open.

### Pending invitation actions — 2026-09-18

The owner answered "1" to the question:

> How should Platform Admin manage pending invitations from Settings > Platform Users?

1. Resend and revoke. Resend the invitation email or cancel acceptance.
2. Revoke and create again. Cancel the existing invitation and repeat the invitation process when needed.

Platform Admin can resend or revoke a pending invitation from Settings > Platform Users.
Resend sends another invitation email to the invited address without requiring the administrator to repeat the invitation process.
Revoke prevents acceptance of that invitation. It cannot activate platform access after revocation.
These actions concern pending invitations. They do not define suspension or removal of an active platform user.
The invitation validity period is seven days. Resend restarts that period, as confirmed below. [Undelivered invitations stay pending](#invitation-delivery-failures--2026-10-05).

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
Resend also applies to expired invitations, as confirmed below. [A revoked address requires a new invitation](#invitations-after-revocation--2026-10-05).

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

### Invitations after revocation — 2026-10-05

The owner answered "New invitation" to the question:

> After Platform Admin revokes a pending invitation, how can that same email address be invited again?

1. New invitation. The revoked invitation stays revoked. Platform Admin invites the address again through the normal invite flow and selects sign-in methods again.
2. Resend reactivates it. Resend applies to revoked invitations like expired ones. It keeps the original sign-in method selection.
3. Cannot be re-invited. A revoked address is blocked from future invitations.

A revoked invitation stays revoked. Resend does not apply to it.
Platform Admin can invite the same address again through the normal invitation process.
Platform Admin selects allowed sign-in methods again for the new invitation.
The new invitation has its own seven-day validity period.
Revocation does not block future invitations to that address.
[Revocation removes assignments configured for the pending invitee](#assignments-after-revocation--2026-10-05).

### Assignments after revocation — 2026-10-05

The owner answered "Remove them with it" to the question:

> When Platform Admin revokes a pending invitation, what happens to the access assignments already set up for that invitee?

1. Remove them with it. Revoke lists the affected assignments and removes them with the invitation. A later new invitation starts with no assignments.
2. Keep them, inactive. They stay on Access Assignments and grant nothing. They take effect if the address accepts a later invitation.
3. Block the revoke. Platform Admin must remove the assignments on Access Assignments first.

Revoking a pending invitation removes the access assignments configured for that invitee.
Before revocation completes, Campus Commander lists the assignments that it removes.
Revocation does not wait for Platform Admin to remove those assignments on Access Assignments.
A later invitation to the same address starts with no assignments.
Removed assignments do not change the referenced roles or OrgUnit collections.
This decision applies to revocation. It does not define assignments for expired invitations.
The exact list presentation remains a design requirement.

### Opening the invitation link — 2026-10-05

The owner answered "Straight to sign-in" to the question:

> When an invitee opens the link in their invitation email, what should they see?

1. Straight to sign-in. A page names Campus Commander and shows only the sign-in methods allowed for that invitee. Signing in verifies the invited address and accepts the invitation in one step.
2. Accept button first. A page shows the invitation details and an Accept button. The invitee then signs in and verifies.

The invitation link opens a sign-in page that names Campus Commander.
The page shows only the sign-in methods allowed for that invitee.
Signing in through an allowed method verifies the invited address and accepts the invitation in one step.
No separate Accept button exists.
Access then activates under the [access activation rule](#access-activation--2026-09-17).
The destination after acceptance remains open. [Expired or revoked links show one generic message](#invalid-invitation-links--2026-10-05).

### Invalid invitation links — 2026-10-05

The owner answered "One generic message" to the question:

> What should someone see when they open an expired or revoked invitation link?

1. One generic message. "This invitation is no longer valid. Contact your administrator." It does not reveal whether the invitation expired or was revoked. It shows no sign-in options.
2. Specific messages. Expired links ask the person to request a resend. Revoked links state that the invitation was cancelled.

An expired or revoked invitation link shows one message:

> This invitation is no longer valid. Contact your administrator.

The page does not reveal whether the invitation expired or was revoked.
The page shows no sign-in options.
[A link for an already accepted invitation opens the normal sign-in page](#accepted-invitation-links--2026-10-05).

### Accepted invitation links — 2026-10-05

The owner answered "Normal sign-in page" to the question:

> What happens if someone opens an invitation link after the invitation was already accepted?

1. Normal sign-in page. The link works like the regular sign-in page with that person's allowed methods. Sign-in still requires their verified identity.
2. Generic invalid message. Show the "no longer valid" message. The person signs in through the regular sign-in page.

A link for an already accepted invitation opens the normal sign-in page.
The page shows the allowed sign-in methods of that platform user.
Sign-in still requires an allowed method and the platform user's verified email address.
The link grants no access by itself.

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
[Revoking the invitation removes these assignments](#assignments-after-revocation--2026-10-05).

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

### Fixed built-in role definitions — 2026-09-18

The owner answered "1" to the question:

> Should the built-in Platform Admin and Asset Super Admin role definitions be editable?

1. Fixed and undeletable. Administrators manage who holds them, while their meaning stays consistent.
2. Editable permissions, but undeletable. Administrators can change what these roles permit.

Platform Admin and Asset Super Admin are built-in roles with fixed definitions.
Platform Admin cannot edit their definitions or delete either role, including when no assignment references it.
Platform Admin can manage who holds these roles through access assignments.
Their confirmed authority remains unchanged. Asset Super Admin alone does not grant platform administration authority.
Custom roles retain editable permissions and cannot be deleted while assignments reference them.
The exact presentation of built-in role assignments remains a design requirement.

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
The list is illustrative, not a complete catalog. Exact action coverage and other dependencies require definition before dependent implementation.
[Write, Deprovision, and Bulk Actions include the entity's Read permission](#included-read-permission--2026-10-05).
Do not assume Write includes Deprovision, schema management, or bulk actions.
Bulk Actions and action-specific permissions work together as confirmed below.

The owner clarified the terminology and scope of the examples:

> Deprovision yea. But like you said this is not a exhaustive list

Use "Device Deprovision" for the existing [Deprovision action](../portfolio/02-domain-model.md#devices-chromeos).
This replaces "Device Deprecate" in the permission labels. The original quotation remains above for provenance.
The owner explicitly confirmed that the list is non-exhaustive.
Define additional permissions as their workflows require them. Do not require the entire catalog before progress.

User Schema Manage is confirmed as a distinct permission. [It covers custom schema definitions only](#user-schema-manage-coverage--2026-10-05).
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

### Included Read permission — 2026-10-05

The owner answered "Include Read automatically" to the question:

> Should Device Write, Device Deprovision, and Device Bulk Actions (and the matching User permissions) depend on the Read permission for the same entity?

1. Require Read explicitly. A role cannot be saved with those permissions unless it also has Read.
2. Include Read automatically. Selecting any of those permissions also grants Read. The role editor shows Read as included.
3. Keep them independent. A role can have Write without Read.

Device Write, Device Deprovision, and Device Bulk Actions each include Device Read.
User Write and User Bulk Actions each include User Read.
The role editor shows the included Read permission when one of these permissions is selected.
Read remains included while any permission that includes it remains selected.
The included Read applies within the same access assignment scope.
Included Read does not grant any other action permission.
The Read dependency of User Schema Manage remains open.

### User Schema Manage coverage — 2026-10-05

The owner answered "Definitions only" to the question:

> What does User Schema Manage cover?

1. Definitions only. Create, edit, and delete custom attribute definitions. Changing custom attribute values on users still requires User Write within that user's scope. Schemas apply to the whole domain, so OrgUnit collections do not limit this permission.
2. Definitions and values. Covers schema definitions and custom attribute values on users, without User Write.

User Schema Manage permits creating, editing, and deleting Google Workspace custom user schema definitions.
It does not permit changing custom attribute values on Google users.
Changing a user's custom attribute values requires User Write within the scope that contains that user.
Google custom schemas apply to the whole domain. OrgUnit collections do not limit User Schema Manage.
A role with User Schema Manage grants domain-wide schema control in any assignment that uses it.
The presentation of this domain-wide permission within scoped assignments remains open.

### Group access deferred — 2026-10-05

The owner answered "Decide with groups work" to the question:

> How should access to Google groups work, given that groups do not belong to OrgUnits?

1. Decide with groups work. Leave group access out of this workflow. Settle it when the groups workflow (G21) starts.
2. Domain-wide, like schemas. Group permissions apply to every group in the domain. OrgUnit collections do not limit them.
3. Scoped by members. A group is in scope when its members fall inside the assignment's OrgUnit collection.

Group access is outside this workflow.
The [groups workflow](../workflow-gaps.md#remaining-product-and-interaction-gaps) (G21) defines group permissions and their scope.
This workflow defines no group permissions. OrgUnit collections do not establish group scope.
The development order places groups after devices, Google users, and OUs.

### Device OrgUnit moves — 2026-10-05

The owner answered "Source and destination" to the question:

> To move a device from one OrgUnit to another, where does the platform user need Device Write?

1. Source and destination. The person needs Device Write in both the current OrgUnit and the target OrgUnit. The OU picker shows only valid destinations.
2. Source only. Device Write in the current OrgUnit is enough. The person can move the device out of their own scope.

Moving a device requires Device Write for the device's current OrgUnit and for the destination OrgUnit.
A platform user cannot move a device out of their writable scope.
A platform user cannot move a device into an OrgUnit outside their writable scope.
The OU picker offers only destinations where the platform user has Device Write.
A bulk move also requires Device Bulk Actions and applies this rule to every selected device.
[Google user moves follow the same rule](#google-user-orgunit-moves--2026-10-05).

### Google user OrgUnit moves — 2026-10-05

The owner answered "Same rule" to the question:

> Should moving a Google user between OrgUnits follow the same rule, with User Write needed in both the current and destination OrgUnits?

1. Same rule. User Write is needed in both OrgUnits. The OU picker shows only valid destinations. Bulk moves also need User Bulk Actions.
2. Different rule for users. The owner describes different handling.

Moving a Google user requires User Write for the user's current OrgUnit and for the destination OrgUnit.
The OU picker offers only destinations where the platform user has User Write.
A bulk move also requires User Bulk Actions and applies this rule to every selected Google user.

### Resource access — 2026-09-17

The owner stated:

> Access is scoped by OrgUnits or a collection of OrgUnuits

Resource access is scoped by an OrgUnit or a collection of OrgUnits.
This establishes OrgUnits as the scope basis for the Google users and devices discussed in the preceding question.
It does not establish a separate school entity or authorize school creation.

The descendant-selection decision below defines the control for each selected OrgUnit.
The initial workflow has no collection exclusion rules, as confirmed below. Descendant scope follows the current hierarchy.
The collection and access-assignment decision below defines named reusable collections and their relationship to roles.
[Group access is deferred to the groups workflow](#group-access-deferred--2026-10-05). The detailed platform permission catalog requires separate definition.
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

Overlapping assignments follow the most-permissive rule below. The initial workflow has no collection exclusion rules.
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

### No collection exclusions initially — 2026-09-18

The owner answered "1" to the question:

> Should OrgUnit collections support exclusions?

1. No exclusions initially. Build collections from selected OrgUnits and optional descendants.
2. Allow excluded branches. Include Smith Elementary and its descendants except its Administration branch. Other assignments can still grant access there.

Initial OrgUnit collections contain selected OrgUnits with an optional Include descendants setting for each entry.
They do not support excluded OrgUnits or excluded branches.
To include only selected branches, Platform Admin adds those OrgUnits instead of including a broader ancestor with descendants.
Collection exclusions are outside the initial workflow. They are not a prerequisite for implementation.
The most-permissive rule across applicable assignments remains unchanged.

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
This rule does not bypass invitation, identity, or account-authorization checks. Initial collections have no exclusion rules.

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

This decision covers edits to custom roles and saved collections within Campus Commander. Built-in role definitions remain fixed.
The descendant-hierarchy decision above covers changes to the Google OrgUnit hierarchy.
Effects on work already running remain part of the unresolved access-revocation workflow.

### Deleting assigned roles and collections — 2026-09-18

The owner answered "1" to the question:

> If a role or OrgUnit collection has existing access assignments, how should deletion work?

1. Block deletion. Platform Admin must change or remove those assignments first.
2. Delete its assignments too, after showing the affected users and receiving confirmation.

Block deletion of a role or OrgUnit collection while any access assignment references it.
Platform Admin must change or remove those assignments on Settings > Access Assignments first.
This includes assignments configured for pending invitees.
A blocked deletion leaves the definition and its assignments unchanged.
Deleting a role or collection does not automatically delete its assignments.

After resolving references, Platform Admin deletes the custom role on Platform Roles and Permissions or the collection on OrgUnit Collections.
Platform Admin and Asset Super Admin remain undeletable even without assignments.
Exact blocked-deletion presentation remains a design requirement.

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

The invitation link [opens a sign-in page with the invitee's allowed methods](#opening-the-invitation-link--2026-10-05). Signing in accepts the invitation.
The exact entry controls, success presentation, and return path remain open.

## Permissions and failures

Roles contain permissions. Named OrgUnit collections define resource scope.
An ordinary asset access assignment associates a platform user with a role and an OrgUnit collection.
A platform user can have multiple assignments. Each role remains paired with its assignment's collection.
Within overlapping scopes, permissions combine and most permissive wins.

Each selected OrgUnit has its own "Include descendants" option, which defaults to off when added to a collection.
When enabled, it follows the current Google hierarchy. Collections have no exclusion rules in the initial workflow.
Saved role and collection changes automatically apply to every assignment using them.
Deletion is blocked while assignments reference a role or OrgUnit collection. Resolve those references on Access Assignments first.
Roles use granular permissions, including the owner's initial device and Google-user examples.
Bulk operations require both Bulk Actions and the action-specific permission within the applicable scope.
Write, Deprovision, and Bulk Actions include the entity's Read permission within the same scope.
User Schema Manage covers domain-wide schema definitions only. Custom attribute values require User Write.
A device move requires Device Write for the current and destination OrgUnits.
A Google user move requires User Write for the current and destination OrgUnits.
The remaining catalog, other permission dependencies, exact controls, and scope behavior remain open.

Only Platform Admin manages platform users, roles, OrgUnit collections, and access assignments in the initial workflow.
Platform Admin can assign any role to any platform user, including Asset Super Admin.
Asset Super Admin formally represents full Google resource access and remains distinct from platform administration.
Platform Admin and Asset Super Admin have fixed definitions and cannot be deleted. Their holders remain administratively assignable.

External invitees do not need Google accounts. Configured identity providers and email sign-in codes are supported.
Administrators select allowed methods per platform user. Invitation acceptance requires verification of the invited email address.
Platform Admin updates a changed email address. The platform user verifies the new address before the change takes effect.
Saving the change ends sessions under the former address. The former address cannot sign in.
Platform Admin restores lost sign-in access. No self-service account recovery exists.
A server operator restores a Platform Admin when no Platform Admin can sign in.
Removing an allowed method immediately ends that platform user's sessions created through it.
Every platform user keeps at least one allowed method. Removal of the last allowed method is blocked.
Invitations have a seven-day validity period. Expired or revoked invitations cannot activate access.
Resend starts a fresh seven-day validity period for pending or expired invitations.
Invalid recipient addresses block sending until Platform Admin corrects or removes them.
A revoked invitation stays revoked. Platform Admin sends a new invitation to invite that address again.
Revocation removes the assignments configured for that invitee. A new invitation starts with no assignments.
An undelivered invitation stays pending with a delivery-failed status on Platform Users.
Retain application authorization and credential protection.
No access-request workflow is permitted.

## Examples

- Platform Admin selects three staff members in the searchable Google directory grid and sends their invitations together.
- Each selected staff member must accept and verify their invited email address before their own access activates.
- A staff member opens the invitation link and sees provider sign-in only. Signing in accepts the invitation.
- Platform Admin pastes two external email addresses and reviews the recipients.
- If one address is invalid, no invitations in that selection are sent until it is corrected or removed.
- Before sending together, Platform Admin permits provider sign-in for one recipient and email codes for the other.
- An external consultant without a Google account accepts through an allowed sign-in method.
- Platform Admin resends a pending invitation from Platform Users. Campus Commander sends another invitation email.
- The mail server rejects one invitation email. Platform Users shows that invitation as pending with a delivery-failed status.
- Platform Admin corrects the cause and resends that invitation.
- Before Platform Admin selects a sender mailbox, Platform Users blocks sending and names the missing mailbox.
- Email setup stops working. A consultant allowed only email codes sees that codes are unavailable and contacts an administrator.
- The consultant accepts the invitation and verifies identity through a sign-in method allowed by the administrator.
- A platform user restricted to provider sign-in cannot sign in through an email code.
- Platform Admin removes email-code sign-in from a consultant signed in through an email code. That session ends at once.
- The consultant signs in again through provider sign-in.
- Platform Admin cannot remove provider sign-in when it is the consultant's last allowed method.
- A recipient using a different verified email address cannot accept the invitation.
- Google Workspace renames `mSmith@school.edu` to `mJones@school.edu`. Platform Admin updates the address on Platform Users.
- The session under `mSmith@school.edu` ends when Platform Admin saves the change.
- The platform user verifies `mJones@school.edu`. The same sign-in methods and assignments continue.
- A consultant loses access to their mailbox. Platform Admin allows provider sign-in for that consultant.
- The only Platform Admin cannot sign in. A server operator restores that Platform Admin through operator-credential recovery.
- Platform Admin revokes a pending invitation. The recipient cannot accept it to activate access.
- Platform Admin later invites the same address again. Platform Admin selects sign-in methods for the new invitation.
- That invitee had a pending Librarians and Smith Elementary assignment. Revocation lists and removes it.
- An invitation expires after seven days without a resend. The recipient cannot use it to activate access.
- The recipient opens the expired link and sees: "This invitation is no longer valid. Contact your administrator."
- Platform Admin resends an expired invitation. The recipient receives another email and has seven days to accept.
- Platform Admin resends an invitation two days before expiry. The recipient now has seven days from that resend.
- An invited person accepts a valid invitation and verifies their identity. Access activates without another administrator confirmation.
- While the invitation is pending, an administrator assigns Librarians and Smith Elementary to `mSmith@school.edu`.
- The assignment grants no access until the recipient accepts and verifies their identity.
- That assignment permits device and Google user reads within the collection. It does not permit edits or out-of-scope reads.
- Deleting Librarians or Smith Elementary is blocked while that assignment references it, including while the invitation is pending.
- Platform Admin changes or removes the assignment on Access Assignments before deleting the referenced definition.
- Overlapping read and edit assignments allow both actions within their shared scope.
- Outside the overlap, a read assignment does not gain editing permission from the other assignment.
- Device Bulk Actions enables access to the dropdown. Device Deprovision additionally permits its deprovision feature.
- Device Bulk Actions without Device Deprovision does not permit bulk deprovisioning.
- Platform Admin selects Device Write for a role. The role editor shows Device Read as included.
- An assignment whose role includes User Schema Manage can edit schema definitions for the whole domain.
- That assignment cannot change custom attribute values without User Write for the user's scope.
- A platform user with Device Write for Smith Elementary only cannot move a device to Jones Middle.
- An administrator scopes resource access to one OrgUnit or a collection of OrgUnits.
- To omit Administration, Platform Admin selects the required sibling branches instead of including their ancestor with all descendants.
- Platform Admin adds an OrgUnit to a collection. Include descendants starts off, so the entry includes only that OrgUnit.
- An administrator includes descendants for one selected OrgUnit and selects only another OrgUnit without its descendants.
- A new descendant enters an enabled descendant scope. A moved-out descendant leaves that scope.
- Another applicable assignment still grants access to a moved-out OrgUnit according to the most-permissive rule.
- A Platform Admin can assign Asset Super Admin to another platform user or to themselves.
- Platform Admin cannot edit or delete either built-in role definition, even if it has no assignments.
- Asset Super Admin gives full managed Google resource access without itself granting platform administration authority.
- A platform user without Platform Admin cannot invite people or edit roles, OrgUnit collections, or access assignments.
- An uninvited person cannot request access. The exact sign-in message remains open.

These examples define eligibility, activation, reusable roles, and the OrgUnit scope basis.
Authentication details and scope behavior remain open.

## Exclusions and open decisions

Exclude Google account creation, school creation, and automatic access through an access request.
OrgUnit collection exclusions are outside the initial workflow.
Group access is outside this workflow. G21 defines it.
Do not change application code until the owner authorizes implementation.

Next decisions:

1. Remaining page interactions and Figma compositions within the confirmed separate Settings pages.
2. Remaining action coverage, dependencies, catalog, and scope behavior.
3. Sign-in method controls and validation message presentation.
4. The recipient's destination after acceptance.
5. Sender name and invitation content.

Resolve only decisions needed for this workflow. Other gaps remain attached to their own tasks.

## Completion

Record the agreed administrator and recipient interactions, permission assignment, resource access, and interface placement.
Record the normal outcome and material denied or failed outcomes.
Inspect relevant Figma compositions before authorized screen implementation. Current compositions are missing.
Applicable UI rules: UI-01, UI-03, UI-09, UI-11, GRID-01, and GRID-06.
Current validation covers documentation consistency only. No implementation, browser checks, or visual acceptance occurred.
