# Install the client review build

This procedure installs prebuilt application images through the existing all-Docker installer.
It requires a published review candidate from `codex/cc-60-review-delivery`.
Use a fresh Linux amd64 environment or a disposable WSL installation with Docker Desktop running.
Do not use an earlier development installation as a prerequisite.

For immediate review without Google configuration, use [the local review command](client-review.md).
That command includes simulated sign-in and Google responses.
The packaged application uses your configured identity provider and Google credentials.
Its automated installation checks use simulators. They do not establish live Google privileges or owner acceptance.

## Prepare

1. Identify the immutable review tag in the successful delivery run or its prerelease page.
2. Use the installer from `codex/cc-60-review-delivery`. Its trusted signing identity matches this review build.
3. Prepare an HTTPS hostname and certificate, or select the installer's disposable laboratory certificate option.
4. Prepare the application sign-in client and its protected client-secret file.
5. Register `https://YOUR-HOST/api/auth/callback` as the sign-in client's redirect URI.

Keep the application sign-in client separate from the service account used for background Google access.
Do not enter secret values in shell arguments or commit them to Git.

## Install

From the checked-out delivery branch, run:

```sh
sh install.sh --profile all-docker --qualification --release phase-3-lab-REVISION12
```

Replace `REVISION12` with the first twelve source revision characters from the published review tag.
The installer verifies the archive, manifest, image signatures, and file inventory before application startup.
Follow the guided prerequisite and configuration steps. Select a new installation directory and a disposable `cc-` project name.
The release determines application features. No development-phase selection is required.

Use the installer's enrollment procedure to establish the first platform administrator.
Open the printed HTTPS application address and sign in with that administrator.
Connect the intended Google customer through **Google connection** when real credentials are available.
Then review customer settings, schools, invitations, platform access, and Diagnostics.

## Build identity and limits

The prerelease tag identifies the source revision. `release-manifest.json` identifies each immutable application image.
The delivery run retains packaged authorization and fresh-install workflow reports.
The extracted report includes the manifest hash, report hashes, command, environment, and actual checked workflows.

This build retains candidate-only status. It does not claim production qualification.
Migration, backup, restore, hybrid, Kubernetes, and exhaustive fault qualification are outside this review delivery.
Human accessibility review and owner acceptance remain open.
