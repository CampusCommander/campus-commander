# Phase 3 review readiness

Date: 2026-09-17. Owner: [CC-61](https://easton-consulting.atlassian.net/browse/CC-61).
Status: application review ready. Phase acceptance remains open.

The owner requires a usable greenfield application and fresh installation.
The [current plan](../portfolio/phase-3-current-plan.md) supersedes historical migration, recovery, and deployment-matrix requirements.
This record maps implemented workflows to the selected build. It does not close every original task criterion.

## Selected build

- Release: [phase-3-lab-a043ef187dc6](https://github.com/CampusCommander/campus-commander/releases/tag/phase-3-lab-a043ef187dc6).
- Application source: `a043ef187dc6efbda7b5db84d7367594f0922cb0`.
- Environment: Linux amd64, all-Docker, automated Google and OIDC simulators.
- Build and installed checks: [successful run 35267378305](https://github.com/CampusCommander/campus-commander/actions/runs/35267378305).
- Installation: [fresh-install guide](../testing/fresh-install-review.md).
- Immediate source review: [client review guide](../testing/client-review.md).
- Provenance: [independent download verification](../../deployment/evidence/CC-60-review-a043ef1/release-verification.json).

The independent verifier accepted both blob signatures, three image signatures, and 1,991 inventory files.
This review also checked all 79 application evidence hashes against the signed manifest.
Those reports reside in `qualification/phase3-auth-integration/` inside the downloaded bundle.
The manifest hash is `1764d353fe6158a32d7d029afa980416080d3dda30485fe9c216e9887f74b6a6`.

## Workflow evidence

Report names below refer to the selected bundle, not older reports with similar names in the repository.
All ten [installed workflow checks](../../deployment/evidence/CC-60-review-a043ef1/phase3-workflows.json) passed against the same source and images.

| Tasks        | Current requirement                                     | Inspected evidence                                                                                                                                                            | Remaining limit                                                                                                                 |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| CC-44        | Unattended Google customer, domain, and OU reads        | [Live provider result](../../deployment/evidence/CC-44-live-plumbing-2026-09-17.json). Customer binding and exact scopes passed.                                              | Super Admin fixture. Live revocation, alternate identity, secondary domains, and aliases remain untested.                       |
| CC-45        | Explicit grants and existing sign-in                    | `packaged-integration.json` and `phase3-route-security.json`. Sign-in, sessions, database privilege denial, and request boundaries passed.                                    | Simulated OIDC. No new live browser sign-in claim.                                                                              |
| CC-46        | Confirm one customer and protect background credentials | `google-connection-api.json` and `google-connection-worker.json`. Explicit binding, encrypted activation, worker restart, and shared renewal passed.                          | Live provider proof is separate from simulated installed credential storage.                                                    |
| CC-47        | Save settings and resume onboarding                     | `customer-settings.json`. Reload, conflict, lost-response receipt, offline draft, API restart, and Redis session loss passed.                                                 | Human workflow review remains open.                                                                                             |
| CC-48        | Explain capability health and failures                  | `google-health-api.json`. Partial authorization, denied privileges, quota, network failure, wrong customer, and recovery passed.                                              | No verified license-specific error contract or minimum-role result.                                                             |
| CC-49        | Replace credentials and rotate keys                     | `google-lifecycle-api.json`. Failed replacement preserves the active credential. Rotation, disconnect, reconnect, and browser confirmation passed.                            | Synthetic credentials. No real DWD revocation or key disablement occurred.                                                      |
| CC-50        | Invite a platform user without SMTP                     | `invitations-browser.json` and installed workflow checks. Separate identity, inviter confirmation, scoped access, and denial passed.                                          | Simulated identity provider. Human workflow review remains open.                                                                |
| CC-51        | Review and change explicit access                       | `platform-access-api.json` and `platform-access-browser.json`. Exact grants, stale review denial, receipts, session invalidation, and last-administrator protection passed.   | Human workflow review remains open.                                                                                             |
| CC-52        | Define schools and enforce school boundaries            | `school-references-api.json`, `school-definitions-api.json`, and installed workflow checks. Preview, confirmation, presets, stale references, and cross-school denial passed. | Live fixture validates reference reads only.                                                                                    |
| CC-53        | Revoke access across active sessions                    | `access-revocation-api.json`, `access-revocation-browser.json`, and installed workflow checks. Replica denial, interrupted drafts, and revoked school access passed.          | Some report limit text retains earlier implementation history. The installed report proves current school denial.               |
| CC-54        | Complete accessible browser workflows                   | Packaged browser reports, 38 accessibility reports, and [local client checks](../testing/client-review.md).                                                                   | Zero automated violations. Seventeen contrast checks remain inconclusive. Human screen-reader and usability review remain open. |
| CC-55        | Enforce authorization, audit, and redaction             | `phase3-route-security.json` records 32 routes and 100 boundary checks. `evidence-redaction.json` passed its registered-secret checks.                                        | Redaction evidence has explicit limits for partial secrets and image recognition.                                               |
| CC-56        | Recovery engineering                                    | Existing implementation and historical evidence retained.                                                                                                                     | Further recovery work is deferred by owner direction. It does not block client review.                                          |
| CC-57        | Install the current application from scratch            | [Fresh-install report](../../deployment/evidence/CC-60-review-a043ef1/all-docker-profile.json). Installation, resume, application workflows, and restart checks passed.       | Automated installation uses provider simulators.                                                                                |
| CC-58, CC-59 | Additional deployment profiles                          | Existing hybrid and Kubernetes implementation and evidence retained.                                                                                                          | Further qualification is deferred by owner direction.                                                                           |
| CC-60        | Publish an identifiable review build                    | Signed release, independent verification, and installation guide above.                                                                                                       | Candidate-only release. No production qualification claim.                                                                      |
| CC-61        | Record owner review and final disposition               | This record and the identified review build.                                                                                                                                  | Owner decision, final task dispositions, and authorized Git integration remain open.                                            |

## Open review work

1. Resolve the inconclusive contrast observations against rendered controls in both themes.
2. Complete human screen-reader review. The native screen-reader sample below does not replace that review.
3. Have the owner review connection, settings, invitations, access, schools, and recovery messages in the client.
4. Correct reported defects and verify each affected workflow.
5. Record acceptance or explicit exceptions against the selected build before closing Phase 3.

The 17 inconclusive results concern background overlap or partial obscuration in contrast checks.
They are not recorded as passed contrast checks or confirmed accessibility defects.
All 38 reports mark the human screen-reader walkthrough `not-run`.
Applicable rules: UI-06, UI-09, and UI-10. The source corrections below follow this initial evidence review.

A supplemental [rendered contrast check](../../deployment/evidence/CC-61-rendered-contrast.json) inspected the running source client with actual theme controls.
It measured 180 visible text samples across settings, invitations, school drafts, and platform access in both themes.
All measured ratios met 4.5:1. The lowest ratio was 4.51:1.
The check expanded collapsed details and excluded hidden and disabled controls.
Screenshot inspection confirmed visible settings text and school controls. The check restored the administrator's light theme.
The initial probe included loading states and collapsed content. Those results did not establish product defects.
This supplemental check does not replay every packaged state or close the original 17 inconclusive observations.

## Native screen-reader check

The [native reader result](../../deployment/evidence/CC-61-native-screen-reader.json) records Orca 50.2 with Chromium and AT-SPI2.
All sixteen selected controls passed native focus and spoken-label checks.
The controls cover sign-in, settings, invitations, connection status, school review, and platform access.
Orca also announced **Confirmed save receipt** after the settings save.
The fixture used simulated providers. It made no live Google requests.
Audio went to an isolated null device. Human listening and usability review remain open.

The initial probe raced Orca's automatic whole-page reading, which moved its caret through page content.
A plain HTML control probe passed. Application focus also remained stable without Orca.
The corrected probe disabled automatic whole-page reading through the isolated Orca service and verified the runtime setting.
The complete probe then passed. Desktop preferences and application focus behavior did not change.

The probe also exposed different visible and accessible names for the Google connection navigation link.
The link displayed **Google connection** but exposed **Google customer connection** to assistive technology.
The source correction uses **Google connection** for both names, following [W3C label guidance](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html).
The existing navigation test failed with the matching-name expectation before the correction.
This correction follows the published review build. Its original artifact remains unchanged.
Applicable rules: UI-02, UI-05, UI-09, and UI-10.

## Focused field label correction

Browser checks found a focused field label with 3.7:1 contrast in the dark theme.
Material used the accent color for ordinary focused label text.
The shared theme now uses `text/primary` for focused outlined field labels. Error labels retain their separate semantic color.
The measured foreground and card colors produce 13.83:1 contrast in dark mode and 16.10:1 in light mode.
The existing import test now checks the focused label color and rendered contrast directly in both themes.
It uses a valid address to distinguish ordinary focus from empty-field validation.

The Chromium suite passed 54 checks before that fixture correction. The corrected remaining check then passed separately.
Frontend production build and both lint targets passed. Lint retains five existing warnings and no errors.
The running application also passed navigation-name and focused settings-label checks in both themes after the rebuild.
These checks cover the source corrections. The published review artifact retains its original source and evidence.
Applicable rules: UI-04, UI-05, UI-09, and UI-10.

The approved Easton fixture remains available for read-only API checks without repeated authorization requests.
An Education domain is not a prerequisite for current customer, domain, and OU reads.
Unavailable live fixtures remain explicit limitations. No additional Google scopes or mutations are authorized by this record.

## Jira and Git disposition

The current Jira query returned eighteen tasks under CC-42, from CC-44 through CC-61.
CC-45, CC-47, and CC-50 are In Review. The other tasks are In Progress after CC-61 started this review.
No implementation task is closed by this record.

Native Blocks links still retain the original deployment dependencies.
CC-56 to CC-57 and CC-58/CC-59 to CC-60 describe deferred work, not active review-build prerequisites.
The current plan and task descriptions govern that distinction. The native links have not been removed.

The selected application is in draft PR 21, stacked on draft PR 20 and the earlier implementation branches.
No merge or owner acceptance follows from successful automated checks.
The earlier owner acceptance applies to Phase 2, not this build.
