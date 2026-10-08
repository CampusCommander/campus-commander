# GAM onboarding research

Research date: 2026-09-13.
GAM source: `e9f6e38f6448596ce10ac09093d4601c4cd5e177`.
Status: research retained as design evidence. The approved credential import and installer enrollment now have local implementations.
See [guided onboarding](../../deployment/installer/HOSTED.md#guided-google-setup-and-administrator-enrollment) for the implemented procedure.
Signed release publication and real Google tenant acceptance remain separate requirements.

The installer should guide credential import and administrator enrollment in one process.
GAM provides useful interaction patterns, but its current process still requires manual client credential entry.
Campus Commander should accept the downloaded Google web client JSON and identify the administrator through normal Google sign-in.

**What GAM does**

| Stage                 | Observed behavior                                                                                                                              | Source                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installation          | The installer asks about browser availability. It then offers project creation, administrator authorization, and service account checks.       | [Installer source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam-install.sh#L358-L463)                                                                                                                                     |
| Project authorization | GAM uses its existing project-creation OAuth client with `cloud-platform` and online access. It enables APIs through Service Usage.            | [Project authorization source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/__init__.py#L11618-L11639)                                                                                                                    |
| Client creation       | Console instructions select an Internal audience and Desktop App client. The user copies the client ID and secret.                             | [Console instructions](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/gamlib/glmsgs.py#L44-L79)                                                                                                                             |
| Credential validation | GAM submits an invalid authorization code. An `invalid_grant` response accepts the credential pair. GAM then writes `client_secrets.json`.     | [Credential creation source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/__init__.py#L11786-L11845)                                                                                                                      |
| Browser authorization | GAM uses installed-app OAuth with PKCE. A loopback listener selects ports 8080 through 8098. The terminal also accepts a callback URL or code. | [Callback source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/__init__.py#L11084-L11178), [PKCE source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/__init__.py#L11324-L11377) |
| Ongoing access        | GAM lets the operator select API scopes. It requests offline access and stores credentials in `oauth2.txt`.                                    | [Administrator authorization source](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/__init__.py#L11410-L11450)                                                                                                              |

GAM documents project-creation permissions, Workspace app restrictions, and service account credentials.
Its project creation process therefore covers more authority than Campus Commander sign-in needs.
Some Workspace organizations require an administrator to trust the GAM Project Creation app before project creation succeeds.
[GAM authorization documentation](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/wiki/Authorization.md#L234-L318)

The useful pattern is continuity: each installer stage explains the next action and stores the resulting configuration.
GAM does not demonstrate automatic creation of the ordinary web OAuth client needed here.
Its source still sends the operator to Google Cloud Console for client creation.
[GAM client instructions](https://github.com/GAM-team/GAM/blob/e9f6e38f6448596ce10ac09093d4601c4cd5e177/src/gam/gamlib/glmsgs.py#L44-L79)

**Google requirements for Campus Commander**

Google documents Web application clients for servers that protect client secrets.
The operator registers an exact callback URI and downloads a JSON credential file.
Google permits localhost callback addresses for testing.
The client secret requires protected storage outside the source repository.
[Google web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)

Google configuration still requires a project, consent configuration, and an OAuth client.
An Internal audience requires an appropriate Google Cloud organization.
Workspace app restrictions remain an administrator concern.
This research does not establish a supported API that eliminates all console steps for ordinary web client creation.
[Google credential creation](https://developers.google.com/workspace/guides/create-credentials#oauth-client-id), [Google consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent)

Normal OIDC returns a signed ID token with the stable `sub` claim.
The application validates its signature, issuer, audience, expiration, and request nonce.
It binds the callback to the browser request through state.
Email addresses do not replace `sub` as identity keys.
Use a verified `hd` claim for an explicit Workspace domain restriction.
A login hint or an email suffix does not enforce that restriction.
Scopes `openid profile` provide the existing identity flow.
Add `email` only when the interface needs a verified email display or comparison.
[Google OIDC reference](https://developers.google.com/identity/openid-connect/reference#id-token), [Google OIDC implementation guide](https://developers.google.com/identity/openid-connect/openid-connect)

Google deprecated its OAuth out-of-band flow.
Use the application's registered callback instead of an API Playground or a copied OAuth code.
The remote Ubuntu test already has an SSH tunnel to the registered localhost callback.
Keep that tunnel active during enrollment.
[Google OOB migration guide](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration), [Ubuntu testing guide](../testing/phase-2-ubuntu-google.md)

**Proposed credential import**

These requirements describe a proposed Campus Commander design.

1. Ask the operator to select Google Workspace as the sign-in provider.
2. Display the exact callback URI before the operator creates the Google client.
3. Provide console links and instructions for a Web application client.
4. Accept the downloaded JSON through a protected browser upload.
5. Offer a local JSON file import for terminal-only operation.
6. Reject Desktop App and service account JSON with a specific correction.
7. Validate the `web` object, client ID, client secret, and registered callback list.
8. Require the configured callback in that list.
9. Fix the Google issuer and endpoints through trusted provider configuration.
10. Reject conflicting endpoints instead of trusting arbitrary URLs from uploaded JSON.
11. Store the client secret in the installation's protected secret store.
12. Write the client ID and managed secret reference automatically.
13. Complete a real Google authorization exchange before reporting sign-in configuration as verified.

The JSON import removes separate client ID and secret-path entry from the normal process.
A browser upload also removes Windows-to-Ubuntu file copying from that process.
An installer JSON-path prompt is an intermediate improvement, but it retains the remote file-transfer problem.
Upload handling needs a size limit, secret redaction, atomic writes, and explicit replacement behavior.
The installer must preserve working credentials after cancellation or a failed replacement.

Credential import must work before the application API has its Google configuration.
Use a temporary setup listener owned by the installer and bound only to loopback.
For a remote Ubuntu host, forward that listener through SSH to the operator's browser.
Require the separate pairing credential before upload, plus exact Origin checks and request forgery protection.
Keep setup pairing and Google callback addresses distinct. The Google callback remains on the application origin.
Stop the temporary listener when setup finishes or the operator exits.
This browser transport is proposed work. The current installer does not provide it.

**Proposed first administrator enrollment**

The installation operator already owns the authority to initialize application access.
The current contract keeps the migration credential outside runtime API, frontend, edge, and worker containers.
The enrollment design must preserve this boundary.
[Application access contract](../../deployment/bootstrap/APPLICATION-ACCESS.md)

1. Start a short-lived enrollment attempt from the installer after service readiness.
2. Bind the attempt to the installation and a random, single-use operator capability.
3. Show the setup address and a separate pairing code in the terminal.
4. Require that capability before the browser can start administrator enrollment.
5. Run the normal Google sign-in flow through the registered application callback.
6. Validate the returned identity through the existing OIDC verifier.
7. Present the verified account to the installation operator.
8. Require explicit operator confirmation before the administrator grant.
9. Invoke the existing privileged enrollment operation inside the installer.
10. Commit the administrator grant and consume the enrollment attempt atomically.
11. Close initial enrollment after success and confirm the result in the terminal.

The identity verifier must pass its result through an authenticated channel to the installer.
The browser must not submit an arbitrary issuer or subject as verified identity.
Runtime services must not acquire the migration credential to implement this flow.
The initial administrator must not be whichever visitor signs in first.
An empty administrator table does not authorize enrollment.

Request only identity scopes for this operation.
Gmail, Drive, Directory, Cloud project administration, service accounts, and domain-wide delegation do not belong in first administrator enrollment.
Background Google authorization remains a separate Phase 3 responsibility under the application access contract.
[Application access contract](../../deployment/bootstrap/APPLICATION-ACCESS.md)

**Proposed progress and recovery behavior**

Step 5 should report its current operation and elapsed time during long-running commands.
TTY output should update an activity indicator.
Redirected output should emit periodic plain text updates.
The indicator must describe activity without inventing a completion percentage.
After service readiness, show an explicit administrator-enrollment state until enrollment completes or the operator exits.

Persist completed stages and keep secret material out of progress records.
On resume, inspect the database before creating another enrollment attempt.
Preserve an existing administrator and report that enrollment already completed.
Expire interrupted attempts without granting access.
If enrollment committed before the terminal disconnected, resume must recognize that success.

**Required validation before release**

| Test                                                       | Expected result                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Long image download, migration, and readiness wait         | The installer reports activity throughout the wait.                                      |
| Redirected installer output                                | Logs contain plain progress updates without terminal control characters.                 |
| Valid Google Web application JSON                          | The installer derives the client configuration and protects the secret.                  |
| Wrong client type, malformed JSON, or callback mismatch    | Import fails with a specific correction before credential replacement.                   |
| Successful browser enrollment                              | The installer grants access to the verified identity without a separate operator script. |
| Missing capability, expired attempt, or unrelated browser  | Enrollment denies the request.                                                           |
| Wrong state, nonce, issuer, audience, or invalid signature | Enrollment creates no administrator.                                                     |
| Concurrent enrollment attempts                             | Exactly one initial administrator grant succeeds.                                        |
| Disk full or disconnect before enrollment commit           | Resume preserves configuration and requires a valid new or existing attempt.             |
| Disconnect after enrollment commit                         | Resume recognizes the existing administrator without a duplicate grant.                  |
| Ordinary unregistered sign-in after installation           | Authentication alone does not grant application access.                                  |
| Logs and support records                                   | No client secrets, authorization codes, tokens, or pairing capabilities appear.          |

This research inspected source and official documentation.
It did not install GAM, create Google Cloud resources, or run the proposed enrollment flow.

**Recorded follow-up work**

| Task                                                                                    | Current result                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [CC-39: startup activity](https://easton-consulting.atlassian.net/browse/CC-39)         | Local implementation reports the active stage and elapsed time every five seconds. All 88 installer tests and deployment lint passed. |
| [CC-40: Google client import](https://easton-consulting.atlassian.net/browse/CC-40)     | Proposed protected browser upload with an advanced local JSON import option.                                                          |
| [CC-41: administrator enrollment](https://easton-consulting.atlassian.net/browse/CC-41) | Proposed installer-authorized Google sign-in and internal administrator grant.                                                        |

The startup activity change requires signed publication and a VM check.
The credential and enrollment workflows require implementation and qualification before they replace the current procedure.
