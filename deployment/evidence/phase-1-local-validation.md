# Phase 1 local validation

Validation ran against the uncommitted candidate based on commit `3ab04fd`.
The candidate remains unaccepted.

## Automated checks

The final combined Nx run passed 22 defined targets across deployment, API, worker, and frontend.
Seven unchanged application targets reused the Nx cache.
The deployment configuration suite passed 59 tests.
The deployment module suite passed 58 tests across ten targets.
The example validator accepted all three profiles and confirmed identical application image references.
Socket-based fixtures required approved loopback access outside the restricted sandbox.

The module suite covered installer ownership, credential validation, profile rendering, PostgreSQL, Redis, bootstrap, storage, operations, qualification, and release integrity.
These module checks supplement the runtime evidence linked from each ticket.

## Runtime evidence

- [Installer, credential delimiters, TLS faults, and browser](CC-16-secret-policy-profile-result.json).
- [Installer input provenance preservation](CC-16-preserved-inventory-result.json).
- [Complete hybrid profile](../profiles/hybrid/full-integration-result.json).
- [Native PostgreSQL backup and restore](CC-17-native-result.json).
- [Isolated hybrid data restore](CC-17-hybrid.md).
- [Isolated Kubernetes restore and target startup](CC-17-kubernetes-result.json).
- [Hybrid process faults](CC-18-hybrid-process.md).
- [Complete all-Docker bounded capacity](CC-18-profile-capacity-result.json).
- [Kubernetes process and shared artifact faults](CC-18-kubernetes-result.json).

The installer and hybrid runs used the rebuilt API and worker images recorded in their reports.
The browser run used a synthetic certificate exception.
The hybrid run used one Docker host and separate worker Compose projects.

The [committed bundle isolation check](CC-19-final-bundle-result.json) passed against source commit `7b218fe`.
It verified 1,060 inventoried files and imported the installer with bundled dependencies.
Promotion rejected the candidate because profile acceptance evidence remains incomplete.
The assembly test used explicit synthetic provenance inputs and published nothing.

## Remaining acceptance

Published image qualification, district infrastructure checks, distributed fault coverage, and three human walkthroughs remain incomplete.
The implementation status document tracks the remaining work.
