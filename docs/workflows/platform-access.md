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
The identity verification method and the assigned permissions remain open.

### Interface organization — 2026-09-17

The owner placed all platform settings under Settings and required a separate page for each concern.
[UI-11](../ui/rules.md#ui-11--settings-organization-and-visible-work) contains the canonical layout rules and the owner's named concerns.
Platform Users and Platform Roles and Permissions are separate concerns under Settings.
The location and interaction for assigning a person's permissions remain open within this organization.

## Interaction

The workflow belongs to the Platform Users concern under Settings.
Administrators can select a directory account or invite someone outside the Workspace.
Campus Commander delivers the invitation by email.
The recipient accepts a valid invitation and verifies their identity. Access activates immediately without another administrator confirmation.
The exact entry controls, identity verification steps, success presentation, and return path remain open.

## Permissions and failures

Permission assignment, resource selection, and delegation authority remain open.
External sign-in requirements, identity matching, invitation failures, expiry, and repeat invitations remain open.
Retain application authorization and credential protection.
No access-request workflow is permitted.

## Examples

- A district administrator selects a staff member from the Google directory for platform access.
- A district administrator invites an external consultant who has no account in the connected Workspace.
- An invited person accepts a valid invitation and verifies their identity. Access activates without another administrator confirmation.
- An uninvited person cannot request access. The exact sign-in message remains open.

These examples define eligibility and activation. They do not specify unresolved authentication or permission steps.

## Exclusions and open decisions

Exclude Google account creation, school creation, and automatic access through an access request.
Do not change application code until the owner authorizes implementation.

Next decisions:

1. Permission assignment, resource access, and delegation authority.
2. External identity requirements and entry method.
3. Identity verification and remaining recipient steps.
4. Detailed page interactions and Figma compositions under the confirmed Settings organization.
5. Email configuration, invitation content, and delivery failure handling.

Resolve only decisions needed for this workflow. Other gaps remain attached to their own tasks.

## Completion

Record the agreed administrator and recipient interactions, permission assignment, resource access, and interface placement.
Record the normal outcome and material denied or failed outcomes.
Inspect relevant Figma compositions before authorized screen implementation. Current compositions are missing.
Applicable UI rules: UI-01, UI-03, UI-09, and UI-11.
Current validation covers documentation consistency only. No implementation, browser checks, or visual acceptance occurred.
