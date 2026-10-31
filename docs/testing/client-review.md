# Review the current client

This command runs the actual application against disposable PostgreSQL, Redis, Kestra, and worker services.
Google sign-in and Workspace responses use a simulator. This environment does not access a live Google customer.

## Start

1. Start or resume Docker Desktop, or start your Linux Docker daemon.
2. Use Node 24.19 and run `npm ci` from the repository root.
3. Run `npm exec -- nx run api-e2e:client-review`.
4. Open the HTTPS URL printed after startup completes.
5. Accept the local development certificate for the displayed loopback address.
6. Select **Sign in to Campus Commander**.
7. Select **Sign in as review administrator** on the simulated provider page.

A session lasts 8 hours. It also ends after 30 minutes without a request.

The simulated sign-in provider uses a second loopback port with the same development certificate.
Your browser also requests certificate acceptance there when needed.
Sign-in returns you to the application as **Review administrator**.
No password or real Google login is required.
The **Development review** notice identifies the simulated Google environment on every signed-in page.

## Review against admin-sdk-mock

The `client-review-mock` target runs the same review environment against the Admin SDK mock.
The harness runs the mock as a container on the review network, so every Google call goes to it.
The review environment does not reach Google and does not use the in-process simulator.
The environment runs the pinned tarball `campuscommander-admin-sdk-mock-0.3.0.tgz`.
The [Admin SDK mock runbook](admin-sdk-mock.md) describes the package, the settings, and the scale record.

```sh
npm exec -- nx run api-e2e:client-review-mock
```

The command prints these values after startup:

- `Google backend`: the mock version, the tier, and the device count.
- `Google customer`: the mock customer ID.
- `Delegated admin email`: the mock administrator. Use this value as the delegated email.
- `Mock service-account file to import`: the credential file for the Google connection page.
- `Mock control URL`: the control endpoint of the running mock.

Set the tier with `CC_MOCK_TIER`. The tiers are `small`, `medium`, `large`, and `xlarge`.
The `client-review-mock` target seeds `medium` by default, which serves 7,000 devices.
The `admin-sdk-mock-integration` and `admin-sdk-mock-exit-test` targets keep the `small` default, which serves 600 devices.
The `admin-sdk-mock-fixture-test` probes seed `small` directly.
A shell `CC_MOCK_TIER` overrides every default.
Set `CC_MOCK_DELAYS=off` to remove the modeled latency. The default is `on`.
The seed is fixed at `campus-commander-review`, so the customer ID and the district are stable.
Every mock district is `Easton Consulting` on the administrator domain below, with admin-sdk-mock 0.3.0.
The review seed yields the customer ID `C0mw85f16` and the administrator `admin@easton-consulting.com`.

The harness starts the mock container before the app and watches it during the run.
A stopped mock stops startup, prints the container log within five seconds, and fails the command.
The command never falls back to the in-process simulator.
The harness never prints the review banner after a mock exit.
[The mock runbook](admin-sdk-mock.md#failure-behavior) records the behavior and the exit checks.

Connect Google with the printed file and email. Then select **Refresh inventory** on the Devices page.
The status bar count equals the `Google backend` count printed at startup.
The battery column shows the classes that the mock reports.

`npm exec nx run api-e2e:admin-sdk-mock-integration` runs the same flow without a browser.
It connects the mock credential, runs Refresh Devices, compares the device count and one battery class with the mock, and removes the containers.
It exits 0 on success, so CI can run it.

### Update device completion checks

`npm exec -- nx run frontend-e2e:client-review-update` starts this environment and runs a browser check against it.
The check is `frontend-e2e/src/device-update-u6-review.spec.ts`.
It drives completion steps 1, 3, 4, and 5 of [the update workflow](../workflows/update-device-fields.md) in Chromium.
Preview, the frozen targets, the durable job, the worker, settlement, the device stream, and the inventory read use the application.
No route is intercepted. Every Google call reaches the mock.
The command stops the environment that it started and writes screenshots to `dist/e2e-evidence/u6-review`.
The normal Chromium suite skips these checks. Set `CC_U6_REVIEW=1` and `BASE_URL` to run the spec by hand.

### Recorded medium review run

The environment reached its ready banner 27 seconds after the command started on 2026-10-16.
That run used the 0.2.0 pin.
The shared Nx cache held the four build outputs, so the number measures the harness start.
The banner reported `admin-sdk-mock 0.2.0, tier medium, 7000 devices`.

**Refresh Devices** published 7,000 devices in 58.8 seconds, from the API sync projection.
The status bar held `7,000 matching devices · 7,000 in district`.
`node api-e2e/client-review-mock-browser.mjs` saved `dist/client-review/devices-medium.png` and `dist/client-review/google-connection-medium.png`.
The connection page listed `easton-consulting.com` as the primary domain and `k12.easton-consulting.com` as a verified alias.

### Scale run

`CC_MOCK_TIER=large` serves 60,000 devices. Run the integration target to observe the full sync:

```sh
CC_MOCK_TIER=large npm exec -- nx run api-e2e:admin-sdk-mock-integration
```

The recorded run published 60,000 devices in 493.6 seconds.
The run writes `dist/client-review/admin-sdk-mock-run.json` with the tier, the device count, the sync duration, the checked battery, and the mock quota counters.
[The scale record](admin-sdk-mock.md#scale-observation) holds the numbers and the quota counters.

## Review the features

- **Your account:** Follow the task links. Change the theme and collapse the navigation.
- **Google connection:** Select the generated sample service-account file printed in the terminal.
  Enter `administrator@fixture.invalid` as the delegated email. Check the credentials and confirm the simulated customer.
- **Devices:** Select **Refresh inventory**, add a filter, open a device, and use **Next device** and **Back to devices**.
  Filter from a column header, select devices, and use **Show All Selected** in the status bar. Page through the grid and use the Columns side bar.
  Group by Battery from the column menu, open a group, and select it.
  The simulated customer has 450 devices with all battery classes.
- **Customer settings:** Save a customer display name and inspect the setup progress.
- **Schools:** Refresh Google units and choose which units belong to each school.
- **Platform invitations:** Create an invitation and inspect its status.
- **Platform access:** Inspect the administrator and assigned permissions.
- **Diagnostics:** Check application services and Google access.

Never upload real Google credentials to this simulated environment.

## Review an invitation

1. As the review administrator, open **Platform invitations**.
2. Enter a recipient name. Leave the optional sign-in ID empty or enter `review-recipient`.
3. Select the permissions to grant, then select **Create invitation**.
4. Copy the invitation link into a separate browser profile or private window.
5. Select **Sign in to accept invitation**, then **Sign in as review recipient**.
6. In the administrator window, refresh invitations and select **Review identity**.
7. Verify the sign-in ID `review-recipient`, confirm the checkbox, and select **Confirm identity and grant access**.
8. In the recipient window, check the invitation status and select **Sign in to Campus Commander**.
9. Select **Sign in as review recipient** again. Inspect the access that the selected permissions allow.

The recipient starts without application access. The application uses its actual invitation, identity confirmation, and permission checks.
The simulated provider keeps each browser's identity choice separate. It does not create real Google accounts.
Live Google authorization still requires separate checks.

## Stop and restart

Stop the command with Ctrl+C. It removes the review containers and temporary credentials.
The next run creates new test data and prints a new URL.
`dist/client-review/runtime.json` records the current URL and sample file path while the command runs.
Do not treat this development command as a production installer or a full qualification run.

### After a frontend rebuild

A build or cache restore can replace the directory mounted by the running frontend container.
The API remains available, but browser pages return HTTP 502 when that mount points to the old, empty directory.

1. Run `docker ps --format '{{.Names}}'` and identify this review environment's `cc-phase2-frontend-…` container.
2. Restart that container with `docker restart <frontend-container-name>`.
3. Reload the review URL and confirm that the sign-in page opens.

Restart only the matching frontend container. The API, services, and review data can remain running.

## Client changes

The account page now directs users to the tasks their permissions allow.
School-scoped users see school access without district configuration or platform-access links.
Applicable rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-09, UI-10, and FORM-01.
Browser checks cover task visibility, keyboard navigation, both themes, automated accessibility, and a 320-pixel viewport.
Human screen-reader review and owner acceptance remain separate checks.

## Validation on 2026-09-17

All 53 existing Chromium client tests passed before the change.
The two focused account tests passed after the change, including both themes and automated accessibility checks.
Frontend unit tests, affected lint checks, and the application builds passed.
The running review environment passed real browser sign-in, customer connection, settings save and reload, and Schools navigation.
Those browser requests reached the actual API and disposable data services. Google responses remained simulated.

The identity chooser passed keyboard activation, automated accessibility in both themes, and a 320-pixel viewport check.
Two browser sessions verified separate identity choices and denied recipient sign-in before an invitation.
The invitation workflow passed creation, pending identity verification, administrator confirmation, and recipient sign-in.
The recipient received only the approved customer-read grant. Customer settings stayed read-only, and invitation administration returned HTTP 403.
The administrator could inspect the recipient through Platform access.
Affected lint and formatting checks passed. Lint retains one existing unused-variable warning in the deferred update fixture.
These checks do not establish human screen-reader acceptance or live Google authorization.

The running application also passed school creation through reference selection, scope review, explicit confirmation, and saved receipts.
The administrator assigned a school-viewer grant through Platform access. The access change invalidated the recipient's previous session.
After sign-in, the recipient saw only the approved school. The second school's API returned HTTP 404, and management controls stayed hidden.
A focused browser check verified keyboard selection in the organizational-unit picker.
