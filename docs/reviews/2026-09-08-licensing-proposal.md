# Campus Commander licensing proposal

This document records the owner's licensing requirements and the basis for the current draft.
It does not grant rights or replace existing license terms.

## Proposed model

Campus Commander will offer two licensing paths:

1. A free, perpetual license for Eligible Organizations worldwide and their own institutional use.
2. A separate paid agreement for uses outside that grant, including ineligible nonprofits.

The proposed name is Campus Commander Community License 1.0.0.
The [adapted license draft](campus-commander-community-license.draft.md) contains the proposed terms.
The draft remains separate from the root license until the Licensor adopts it.
The commercial restrictions make this source-available dual licensing under the [Open Source Definition](https://opensource.org/osd).

## Confirmed owner decisions

- Public K–12 schools, their public districts, and public colleges and universities qualify worldwide.
- Other nonprofits qualify only if all their services are free of charge, including tuition.
- Nonprofit status alone does not qualify an organization.
- Paid contractors can act solely on an Eligible Organization's behalf under its license.
- Eligible Organizations can modify and reuse covered code for their own institutional purposes.
- Compliant rights for a licensed version remain perpetual without a renewal fee.
- Uses outside those grants require a separate paid license.

Public educational institutions retain their separate exemption, including public colleges and universities that charge tuition.
The free-services requirement applies to other nonprofits, including private nonprofit schools.

## Basis and adaptation

The basis is [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
Its [source repository permits adaptation](https://github.com/polyformproject/polyform-licenses#license).
It requires removal of its name and domain from modified license text.
The adapted license therefore uses its own name and contains neither identifier.
This review document records provenance separately from the adapted license.

The draft retains the source's copyright, modification, patent, notice, patent-defense, and violation structure.
It retains the source's No Liability sentence verbatim and its 32-day first-notice cure period.
Other clauses use shorter wording and the owner's specific scope.

The adaptation replaces broad noncommercial, personal-use, and organization permissions with explicit Eligible Organizations and Permitted Purposes.
Distribution is limited to authorized operations, free sharing with eligible recipients, and changes submitted to the Licensor.
Recipients receive no broader operational rights through distribution.
A public repository does not grant an unrestricted commercial license.

The draft adds perpetual compliant rights, authorized paid contractors, third-party-license protection, and a separate paid-license requirement.
These changes make it a custom license derived from an established license, not the unchanged standard license.

## How the free-services rule operates

The current draft checks the nonprofit legal entity as a whole.
A free program does not qualify an organization that charges for other services.
The rule includes charges paid by recipients and service bills paid by insurers or other third parties.
Voluntary donations and grants qualify as funding only when they are not service payments or conditions of access.
Employee and contractor compensation does not disqualify an otherwise eligible nonprofit.

| Example | Draft result |
| --- | --- |
| Public university that charges tuition | Free license through the public education exemption. |
| Private nonprofit school with free tuition and no charges for its other services | Free license. |
| Private nonprofit school that charges tuition or mandatory service fees | Paid license required. |
| Donation-funded nonprofit that provides every service free | Free license. |
| Nonprofit insurer that charges premiums | Paid license required. |
| Nonprofit clinic that bills patients or insurers | Paid license required. |
| Nonprofit with one free program and other paid services | Paid license required. |
| Contractor paid to maintain an eligible organization's installation | Covered only for that organization's authorized use. |

## Remaining adoption details

| Term | Required information or review |
| --- | --- |
| Licensor | Spencer Easton. Website: https://easton-consulting.com |
| Licensing contact | spencer@easton-consulting.com |
| Legal review | Ownership, prior grants, eligibility wording, enforceability, and public-institution contracting. |
| Contributions | Rights sufficient for both licensing paths before accepting outside code. |
| Paid agreement | Scope, customer, fees, and commercial terms before granting paid rights. |

The draft contains a warranty disclaimer and liability exclusion subject to applicable law.
These clauses do not guarantee protection from lawsuits or override mandatory liability rules.

## Repository findings and publication preparation

The working README no longer identifies the license as MIT. Earlier committed versions contain that statement.
No root LICENSE, COPYING, or NOTICE file was found in the current tracked tree.
The root package manifest does not declare a license.
These observations do not determine the legal effect of earlier distributions or agreements.

The [MIT license](https://opensource.org/license/mit) permits commercial use and redistribution.
Review prior distributions and grants before applying new restrictions.
A new license must not purport to cancel rights already validly granted to recipients.
Retain required third-party notices and check distribution obligations for bundled components.

The release packager selects tracked deployment files and runtime output.
Adding a root license alone will not establish that the installation archive includes it.
Adoption must cover source notices, package metadata, image contents, installation bundles, and the customer installation flow.
Publish a new immutable candidate after these changes. Do not replace existing signed candidate assets.

Confirm copyright ownership and contributor permissions before offering both licensing paths.
The [Copyright Office guidance](https://www.copyright.gov/eco/help-claimant.html) explains ownership through authorship and transfers.

Review full Git history, release assets, Actions logs, and configuration for credentials and private information before public release.
This document records no completed secret scan or public-release security approval.
[GitHub documents](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) that public visibility exposes Actions history and permits public forks.
[Existing forks and local copies persist](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) after a repository returns to private visibility.
