# Campus Commander

Campus Commander connects one Google customer account and delegates application access within that customer.
The [portfolio glossary](docs/portfolio/02-domain-model.md) defines the broader product language.

## Platform access language

Source: [owner-confirmed access model, 2026-09-17](docs/workflows/platform-access.md#roles-orgunit-collections-and-access-assignments--2026-09-17).

**Platform user**:
A person authorized to use Campus Commander.
_Avoid_: Google user as a synonym. Managed Google Workspace accounts are separate resources.

**Permission**:
A separately selectable capability in a role, such as Device Read or Device Bulk Actions.
_Avoid_: Role as a synonym for one permission.

**Role**:
A named reusable collection of permissions, such as Librarians.
_Avoid_: Resource scope or OrgUnit collection as synonyms.

**Platform Admin**:
The platform administrator who can assign any role to any platform user, including themselves.
Full asset access is formally represented by the distinct Asset Super Admin role.
_Avoid_: Treating platform administration and asset administration as interchangeable responsibilities.

**Asset Super Admin**:
The special built-in Campus Commander role representing full access to managed Google resources across the connected Workspace.
_Avoid_: Google Workspace Super Admin, which is a Google-side role, or Platform Admin as a synonym.

**OrgUnit collection**:
A named reusable collection of OrgUnits defining resource scope, with an "Include descendants" option for each entry.
An OrgUnit collection such as Smith Elementary represents a school for access administration.
_Avoid_: A separate school entity as the access model.

**Access assignment**:
For ordinary asset roles, the association of a platform user, a role, and an OrgUnit collection.
_Avoid_: Job assignment, which concerns worker execution.

## Historical school access language

These terms describe the existing implementation, whose product scope the owner disputes.
The owner-confirmed OrgUnit collection model replaces the independent school-identity interpretation.
These historical terms do not authorize school creation or a Schools page. See [G03](docs/workflow-gaps.md#decisions-needed-for-access-and-setup).

**School scope**:
A district-defined school identity with explicit resource inclusions and exclusions within one customer account.
_Avoid_: OU, domain, subtree as names for the school itself.

**OU reference**:
A customer-bound reference to one organizational unit by its stable Google identity.
Its path describes its location and does not define its identity.
_Avoid_: OU path as an identity.

**Approved OU set**:
The explicit OU identities accepted in a school-scope confirmation.
_Avoid_: Live subtree, automatic membership.

**Effective OU set**:
The approved OU identities that remain eligible under current verified references and the saved inclusion and exclusion rules.
_Avoid_: Inventory, device count, user count.
