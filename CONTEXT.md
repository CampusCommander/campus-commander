# Campus Commander

Campus Commander connects one Google customer account and delegates application access within that customer.
The [portfolio glossary](docs/portfolio/02-domain-model.md) defines the broader product language.

## School access language

These terms describe the existing implementation, whose product scope the owner disputes.
They do not authorize school creation or a Schools page. See [G03](docs/workflow-gaps.md#decisions-needed-for-access-and-setup).

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
