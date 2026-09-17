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

The simulated sign-in provider uses a second loopback port with the same development certificate.
Your browser also requests certificate acceptance there when needed.
Sign-in returns you to the application as **Review administrator**.
No password or real Google login is required.
The **Development review** notice identifies the simulated Google environment on every signed-in page.

## Review the features

- **Your account:** Follow the task links. Change the theme and collapse the navigation.
- **Google connection:** Select the generated sample service-account file printed in the terminal.
  Enter `administrator@fixture.invalid` as the delegated email. Check the credentials and confirm the simulated customer.
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
