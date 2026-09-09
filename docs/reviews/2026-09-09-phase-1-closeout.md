# Phase 1 closeout review

Review date: 2026-09-09.
The review compared implementation `3e6a6a67a2c3d29dda9546d7141bc58d3127bc84` against baseline `556cee09ba72dee24f14787828b31af969c0ea0f`.
It also reconciled the public hosted validation record from commit `701bcf6`.
Jira CC-4 through CC-20 supplied the acceptance criteria.

## Standards

The review found two code defects and one documentation conflict.

Preflight accepted any nonempty Docker or Compose version and did not inspect the Kubernetes server version.
The correction defines minimum versions and supported major versions in one contract.
Preflight records observed versions and rejects malformed, older, prerelease, and unsupported-major versions.
Exact tested versions remain distinct from compatibility bounds.

Release acceptance allowed any inventoried file to satisfy an evidence hash.
The correction binds each record to a unique path and exact checksum.
It validates report status, profile, check, source revision, and application images.
Both supported signature-verification paths apply the correction.

The network contract prohibited published worker ports while hybrid documentation required private worker listeners.
The corrected contract distinguishes internal all-Docker services from private hybrid interfaces.
An operator must verify the external firewall allowlist. The installer does not administer that firewall.

Duplicated secret-path mapping remains a nonblocking maintenance observation.
No broad path-module refactor was required for this closeout.

## Spec

The [acceptance matrix](../../deployment/implementation-status.md) records completed and open criteria.
Hosted installation and resume passed across all three profiles.
Those results do not establish every lifecycle, network, fault, or human acceptance gate.

CC-10 passed worker-host publication and cross-host readback after the initial review.
CC-15 passed 29 connection checks with Calico enforcement after the initial review.
CC-16 needs complete hybrid and Kubernetes lifecycle and backup-gated upgrade evidence.
CC-18 needs the remaining hybrid and Kubernetes storage and certificate fault cells.
CC-20 needs the specified human walkthrough records and completion decision.

The assisted customer session remains recorded separately from agent-operated tests.
The review does not add district production guarantees to synthetic test requirements.
It does not treat missing results as passed.

## Cleanup and validation

The closeout combines public documentation and implementation history.
It retains machine evidence, corrects stale publication statements, and reconciles current Jira keys and status.
It excludes generated test credentials and preserves unrelated local work.

The unused Angular placeholder library was removed.
The obsolete Jest API scaffold was replaced with a built-server test.
That test verifies startup, denied bootstrap access without configuration, and process shutdown.
Main CI now runs that test and includes operations and qualification checks.

The release and installer regression suites passed after both corrections.
The complete installer suite passed 43 tests.
The startup page passed six Chromium checks after installation of the pinned browser runtime.
The initial browser attempt failed because that runtime was absent.

## Decision

The source cleanup can merge after CI passes.
Phase 1 acceptance remains open until the required gates pass.
Phase 2 application work has not started.
