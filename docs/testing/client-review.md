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
- **Schools:** Inspect the available references and define a school scope.
- **Platform invitations:** Create an invitation and inspect its status.
- **Platform access:** Inspect the administrator and assigned permissions.
- **Diagnostics:** Inspect application services and Google capability checks.

The simulator signs in as the same review administrator.
Invitation acceptance by another identity and live Google authorization require separate checks.
Never upload real Google credentials to this simulated environment.

## Stop and restart

Stop the command with Ctrl+C. It removes the review containers and temporary credentials.
The next run creates new test data and prints a new URL.
`dist/client-review/runtime.json` records the current URL and sample file path while the command runs.
Do not treat this development command as a production installer or a full qualification run.

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
