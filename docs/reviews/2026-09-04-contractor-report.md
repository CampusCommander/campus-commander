# Campus Commander: independent preimplementation assessment

> Integration update, 2026-09-05: the [design portfolio](../portfolio/README.md) incorporates this review and subsequent owner decisions.
> Use the portfolio for current planning and package status. This document preserves review evidence and rationale.

Date: 2026-09-04, America/New_York.

Status: revised contractor recommendations. The owner accepted the [job admission policy and retained stack](2026-09-04-job-admission-policy.md). Other recommendations remain proposals.

Companion: [Technical change instructions](2026-09-04-technical-change-instructions.md).

## Contractor verdict

Proceed with the product, but revise the architecture before implementation. Do not release the current work breakdown for execution.

The product addresses a clear operational need: find district entities, understand their condition, and change them with accountable results. The proposed stack can support that need. Several settled decisions undermine the stated goals, however. The most serious problems concern authentication, external request recovery, job admission, and operating the installation.

Keep Angular, LibreGrid, NestJS, PostgreSQL, Redis, Kestra, Nx, and the uniform safety chain. Add durable operation records within the existing workflow. Use owner-controlled Redis holds to pause new jobs after backoff. Make local AI optional. Support one Google Workspace customer account per installation, including its secondary domains.

Workers report backoff to the job service, which writes Redis holds with a 300-second TTL.
Continuing-backoff reports can overwrite ownership and renew expiration. Completion cleanup requires current ownership.
Existing jobs continue. Pending jobs of the held type sort smallest first.
The job service aggregates recovery observations for early release. Five successful calls remains an illustrative threshold.
Without accepted refreshes, holds expire five minutes after their last update.

These recommendations assume a small TypeScript team, no mandatory commercial licenses, and Linux hosting with restricted outbound access. Team skills, procurement constraints, and actual district inventories remain unverified. No performance benchmark, Google integration experiment, installation trial, or district interview occurred during this review.

## What the review examined

The review covered all seven current portfolio documents, their index, and the prototype map. It also examined relevant archived specifications, architecture decisions, research, and the previous consistency audit. Repository inspection included the package manifest, Nx configuration, Compose configuration, and CI workflow.

The portfolio correctly treats existing scaffolding as a false start. This review follows that framing. It does not assess production implementation quality. The prototype map supplied interaction descriptions. This review did not inspect live prototype boards.

The previous audit checked consistency between documents. Agreement between documents does not establish technical feasibility. This assessment checks the design against external constraints and the intended operating model.

## Findings that change the plan

| Priority | Current choice | Contractor finding | Required replacement |
|---|---|---|---|
| Blocker | Identity-only OAuth, a client secret, no durable token, and DWD impersonation | The documented credentials do not provide a complete token-minting path. | Choose and test a supported authentication protocol before building the wizard. |
| Blocker | Retry entire chunks and consolidate audit after execution | A timeout does not establish whether Google applied a change. Repeating work risks duplicate effects. | Record intent before dispatch. Track and reconcile each external operation. |
| Accepted change | New jobs start while active jobs encounter backoff | Independent admission adds pressure without sharing the throttle signal. | Hold new jobs by type in Redis. Existing jobs continue. Order pending jobs smallest first. |
| Blocker | Two roles with entity-type scope across every OU | School staff need school-level boundaries. Type-level permission alone grants excessive reach. | Enforce action, OU, group, field, and export permissions throughout the product. |
| High | Global lock throughout full synchronization | Long sweeps stop unrelated updates. Group membership makes the window especially expensive. | Synchronize collections independently and reconcile concurrent writes explicitly. |
| High | Shared job files and perpetual duplicate storage | Recovery needs explicit storage ownership and retention rules. | Retain Kestra and Redis. Define shared storage, durable operation results, and artifact retention. |
| High | One Compose artifact as the entire enterprise deployment story | One host remains one failure domain. Host-local files constrain additional workers. | One application release with a simple host profile and a separate enterprise profile. |
| High | One deployment per email domain | A Workspace customer account contains multiple domains. | Key tenancy by the stable Workspace customer ID. |
| Retained constraint | LibreGrid supplies the required grid features | The owner authors LibreGrid for this MIT product. Commercial grid licensing is outside the budget. | Retain LibreGrid and test its selection, editing, accessibility, and performance integration. |
| High | Global search and insight deferred, local AI required | This ordering deprioritizes the user's central need while increasing setup cost. | Ship cross-entity search and defined reports before optional natural-language features. |

The authentication and customer-account findings follow Google's [server-to-server authorization](https://developers.google.com/identity/protocols/oauth2/service-account), [web-server authorization](https://developers.google.com/identity/protocols/oauth2/web-server), and [user-list reference](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list). The detailed [Google evidence note](2026-09-04-google-platform-evidence.md) records endpoint constraints and verification limits.

## Performance: separate three different promises

**Finding entities should feel immediate.** Indexed local reads, bounded responses, and virtualized rows determine this experience. Replacing Angular with React does not fix a missing index or an unbounded query. A PostgreSQL-first design is the recommended starting point. It still requires measured query plans under concurrent synchronization and import workloads.

**Accepting an update should feel immediate.** The app should accept an approved operation, show its durable receipt, and continue responding. During a type-specific hold, new jobs wait while existing jobs continue. After release, smaller pending jobs receive priority. This improves small-job ordering without promising immediate dispatch during throttling.

**Completing updates depends on Google.** Google's documented Directory default is 2,400 queries per minute per user per project. Under a simplified one-request-per-write workload, 100,000 updates consume the equivalent of 41.7 minutes at that nominal rate. One million consume about 6.94 hours. Validation reads, verification reads, retries, and competing tools increase those figures. Native bulk endpoints have different arithmetic. These figures do not predict burst enforcement or establish strict completion-time bounds. Additional servers do not create additional entitlement. [Directory limits](https://developers.google.com/workspace/admin/directory/v1/limits)

Request batching reduces transport overhead. Each enclosed request still consumes quota. The app must estimate completion from the operation's API cost and observed throughput. It must not advertise immediate completion of arbitrary district-wide changes. [Directory batching](https://developers.google.com/workspace/admin/directory/v1/guides/batch)

## Recommended technology choices

| Area | Recommendation | Reason and cost |
|---|---|---|
| Frontend | Keep Angular and Angular Material. Use Signals for view state. | Fits the existing team assumption. Virtualization and request discipline matter more than a framework replacement. |
| Grid | Keep AG Grid Community plus LibreGrid. | Preserves required features and the owner's MIT distribution constraint. |
| Backend | Keep NestJS. Retain Express initially. | Avoid an adapter migration without measured need. Keep bulk processing in separate workers. |
| Database | PostgreSQL 18 with SQL-first access through `pg`. | Durable entities, operation records, frozen previews, and audit evidence. |
| Work dispatch | Retain Kestra and separate worker services. | Preserves steps, parallel batches, retries, and collection of settled results. |
| Redis | Retain caching, selection/session services, broadcasts, and job admission holds. | The review did not establish sufficient benefit from removing it. |
| Files | Preserve job files and audit artifacts. Add immediate durable operation results. | Retains the existing workflow while improving recovery evidence. |
| Search | PostgreSQL indexes, typed filters, and ranked cross-entity lookup. | Avoid a second search service until measured requirements justify one. |
| AI | Optional later feature with a resource limit and deterministic fallback. | No model download or GPU prerequisite for basic administration. |
| Packaging | Signed, prebuilt images. Compose for one host. Enterprise deployment contract for existing infrastructure. | Customers install releases instead of building source. |
| Development | Keep Nx and npm. Use risk-first vertical slices and evidence gates. | Build the smallest complete workflow before expanding entity coverage. |

LibreGrid remains part of the selected grid stack. Test its server-side row model and selection with the application's durable preview and draft rules.

The owner authors LibreGrid to supply the required features without commercial per-site licensing. Its repository documents MIT modules and the supported AG Grid peer range. [LibreGrid repository](https://github.com/libregrid/libregrid)

The original pg-boss replacement recommendation is withdrawn. The comparison understated the application orchestration required to replace Kestra. The [runtime evidence note](2026-09-04-runtime-evidence.md) now compares alternatives against the retained architecture.

## Installation for a librarian

The product needs two explicit experiences: operating the app and establishing the district's Google trust relationship. An occasional IT helper should manage routine tasks without understanding containers, OAuth, or database backups. Google authorization still requires an authorized district administrator. A wizard cannot grant privileges the installer does not possess.

Offer a local sample-data mode before requesting Google credentials. Start real connections with read-only capabilities. Enable write capabilities through a separate guided step. Preserve configuration when a trial becomes production through a supported promotion process.

The installer should check host capacity, time, ports, DNS, certificates, outbound access, and backup destination. The setup screen should explain each failed check and the next action. It should resume after browser closure or restart. Downloads, fonts, help content, and application assets should ship with the release.

Keep Compose as the supported first installation format. Reconsider one VM appliance format only if observed installation trials fail the usability target. Avoid maintaining multiple hypervisor images before obtaining that evidence. A librarian still needs a host and someone accountable for its storage and recovery.

## Enterprise scale means more than row count

A metropolitan district needs defined availability, recovery, identity integration, delegated permissions, and support procedures. It also needs an inventory of users, devices, groups, memberships, and retained audit data. A school count alone does not size the installation.

Support the same images against district-managed PostgreSQL, secrets, certificates, and artifact storage. Allow API and worker replicas without shared local job directories. Supply an enterprise Kubernetes or VM reference deployment after testing the district's required environment. Do not require the district to operate a new Kubernetes cluster for Campus Commander. Docker documents Compose production use on a single server. [Compose production guidance](https://docs.docker.com/compose/how-tos/production/)

Do not claim support for Los Angeles Unified or Chicago Public Schools from synthetic row counts alone. The technical plan defines a large synthetic workload and a district acceptance pilot. Actual inventories, Google quotas, availability requirements, and representative workflows must determine the support claim.

## Auditability and reliability

Keep the rule that every mutation follows the same authorization, preview, confirmation, and audit process. Change its implementation. Write the operation intent before sending a request to Google. Record each attempt and distinguish confirmed success, confirmed failure, and unknown outcome.

Keep compact audit evidence under an explicit retention policy. Provide immutable exports to separately controlled storage when the district requires stronger evidence. Files and database rows on one writable host do not prevent a host administrator from altering both. A hash chain without an independent checkpoint does not solve that problem.

Separate reusable entity cache, sensitive export baselines, operational logs, result downloads, and long-term audit evidence. Each requires a different recovery and retention rule. Confirm district retention requirements during onboarding. Do not silently shorten the existing permanent-audit intent.

## Job artifact location

Define a job-storage interface now and implement persistent local storage first.
Before distributing workers, qualify either district shared filesystem storage or S3-compatible object storage.
Shared filesystem storage preserves filesystem access. Object storage uses downloads or streams for inputs and uploads for results.
Both paths retain job manifests, result files, and audit artifacts.

Pass artifact IDs between services. Publish artifacts only after complete writes and integrity verification.
Keep filesystem rename outside the common interface. Configure Kestra internal storage separately.
The [technical storage contract](2026-09-04-technical-change-instructions.md#76-job-storage-interface-and-artifact-publication) defines publication, recovery, and implementation order.

## Process changes before feature work

Replace decisions treated as permanent law with dated decisions that name evidence, alternatives, and conditions for reconsideration. Keep one authoritative architecture and one decision index. Mark superseded decisions directly. Preserve archives as history.

Move authentication, permissions, installation, backup, and crash recovery into the first complete workflow. The current sequence leaves too much operational proof until later packages. Start with a read-only directory, then one audited device annotation, then a large batch. Expand only after those slices pass.

Replace visual completion as the primary proof with task completion by representative users. Test a librarian and a district administrator. Include keyboard operation, screen-reader checks, import conflicts, unknown request outcomes, and recovery from a failed upgrade. Use WCAG 2.2 AA as the proposed engineering target. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Approval gates and decision cost

| Gate | Required evidence | Failure response |
|---|---|---|
| Google connection | An unattended read after restart, credential renewal, revocation, and account replacement | Reject the credential design before wizard implementation. |
| Search and grid | Representative queries and edits at three inventory sizes, including a large membership graph | Fix queries and interactions before adding a search engine or replacing frameworks. |
| Mutation recovery | Fault injection before dispatch, after Google acceptance, and before local result commit | Reject retry behavior that repeats unsafe operations. |
| Installation and recovery | Unassisted setup study, backup verification, and restore to a clean host | Revise packaging and support scope before claiming easy installation. |
| Enterprise support | Concurrent workload, database failover, restore, and district permission acceptance | Limit the supported deployment profile until the evidence exists. |

The retained stack needs measured operating costs. A smaller first release and optional AI reduce initial delivery scope. The main added investment belongs in Google integration tests, database design, operation recovery, and installation usability. These are prerequisites for the product promise. Replacing the frontend framework does not substitute for them.

The [technical change instructions](2026-09-04-technical-change-instructions.md) specify what to remove, where to remove it, what to insert, and how to accept each change.
