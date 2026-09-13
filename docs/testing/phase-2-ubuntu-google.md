**Phase 2 testing recipe: fresh Ubuntu and Google Workspace**

Start here after installing Ubuntu on your test VM.
Use your ordinary Ubuntu login with sudo access. Use your Windows computer for the browser and Google setup.
The reference platform is Ubuntu 24.04 LTS on Intel or AMD 64-bit hardware.
Allow 8 GB RAM and sufficient disk space. This recipe uses the all-Docker installation mode.

Target test release: `phase-2-candidate-8b8d5a15c756`.
Installer source revision: `8b8d5a15c756017255a9e74caa0de2553b2e871f`.
This recipe tests browser credential import, installer administrator enrollment, progress output, update, and uninstall.

**Publication gate:** This recipe does not establish that the target release is available.
Check the [target workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34738281104) before starting.
Wait for successful completion and the [target release](https://github.com/CampusCommander/campus-commander/releases/tag/phase-2-candidate-8b8d5a15c756).
If the workflow fails or the release page is missing, stop and report that result.
Do not substitute release `436d3b0698a5`. It contains the previous onboarding flow.

The [historical recipe](phase-2-ubuntu-google-436d3b0.md) preserves the previous procedure.
The [September 12 result](phase-2-ubuntu-google-results-2026-09-12.md) applies only to that earlier test.
Record new results for this revision and VM.

Run commands one block at a time. Stop when an expected result fails.
Commands labeled PowerShell run on Windows. Commands labeled bash run on Ubuntu.
`$HOME` means your Ubuntu home directory. Do not replace it in bash commands.
Replace `UBUNTU_USER` with your actual Ubuntu username. Replace `VM_IP` with the VM's IPv4 address.

**1. Prepare Ubuntu**

Log in with the Ubuntu account you created during installation. Run each command separately:

```bash
sudo apt update
sudo apt install -y curl ca-certificates openssh-server python3
sudo systemctl enable --now ssh
sudo timedatectl set-ntp true
uname -m
df -h /
hostname -I
whoami
```

`sudo` requests your Ubuntu password. The terminal does not display password characters.
`uname -m` must report `x86_64`.
The root filesystem needs at least 40 GiB free for the default declared persistent storage, plus download and image space.
A 100 GB virtual disk with its space assigned to Ubuntu provides room for those downloads.

Write down the VM's IPv4 address from `hostname -I` and your username from `whoami`.
Use that address wherever this recipe says `VM_IP`.
Do not type the letters `VM_IP` into commands.

**Expected result:** Ubuntu has internet access, SSH runs, and you know the VM address.

**2. Connect from Windows and open the browser tunnel**

Open Windows Terminal or PowerShell on your Windows computer.
Replace `UBUNTU_USER` and `VM_IP`, then run:

```powershell
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:8443 -L 127.0.0.1:8765:127.0.0.1:8765 UBUNTU_USER@VM_IP
```

On the first connection, check the host fingerprint before accepting it.
The VM console can display its fingerprint with:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Enter the Ubuntu password. Keep this terminal open throughout browser testing.
Commands entered in this connected terminal now run on Ubuntu.

The tunnel connects Windows port 8443 to the application and port 8765 to temporary Google credential setup.
Your browser will use `https://localhost:8443`, even though the application runs inside the VM.
You do not need an application DNS record or a public application port for this recipe.

If PowerShell cannot find `ssh`, install Windows' OpenSSH Client optional feature.
Keep Windows ports 8443 and 8765 free before opening this tunnel.

**3. Register the test application with Google**

Use your Windows browser for these steps.
Open [Google Cloud Console](https://console.cloud.google.com/) with an account that can create an OAuth client.
Create or select a dedicated test project under your Workspace organization.

1. Open **Google Auth platform → Branding** and complete the setup form.
2. Name the application `Campus Commander Phase 2 Test`.
3. Supply your support and contact email addresses.
4. Choose the **Internal** audience for your Workspace organization.
5. Open **Clients** and create a **Web application** client.
6. Name the client `Campus Commander Ubuntu test`.
7. Add this exact authorized redirect URI:

```text
https://localhost:8443/api/auth/callback
```

8. Download the client JSON file.
9. Rename the downloaded file to `client_secret.json` in your Windows Downloads folder.

The application requests only `openid profile` for sign-in.
If Google asks you to declare data access, use OpenID and basic profile information.
This test does not require Gmail, Drive, Directory API scopes, a service account, or domain-wide delegation.
Leave JavaScript origins empty. This application exchanges the authorization code on its server.

If Internal is unavailable, check the project's organization before continuing.
Workspace app controls can require an administrator to permit the test OAuth client.

Google documents [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent) and [client creation](https://developers.google.com/workspace/guides/create-credentials).
Its [web-server flow documentation](https://developers.google.com/identity/protocols/oauth2/web-server) permits localhost test redirects and requires exact redirect matching.

**Expected result:** Your Windows computer holds the downloaded Web application client JSON with the exact redirect URI above.
Keep this file for browser upload during installation. Keep it outside the Ubuntu installation directory during a test reset.

**4. Download and verify the exact Phase 2 release**

Run these commands on Ubuntu:

```bash
mkdir -p "$HOME/cc-test-tools"
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/8b8d5a15c756017255a9e74caa0de2553b2e871f/install.sh -o "$HOME/cc-test-tools/install.sh"
sh "$HOME/cc-test-tools/install.sh" --release phase-2-candidate-8b8d5a15c756 --verify-only
```

**Expected result:** The installer reports that release signatures and file checksums passed.
It prints `Verified release:` followed by a private cache directory.
Stop at a verification failure. Do not remove verification flags or change image digests.

This step downloads the installer runtime privately. It does not install the application.
The script uses its private Node runtime. Ubuntu's `node --version` can still report Node 12 afterward.
Use the script commands in this recipe to select the required runtime.

**5. Install the application**

Run on Ubuntu:

```bash
sh "$HOME/cc-test-tools/install.sh" \
  --release phase-2-candidate-8b8d5a15c756 \
  --profile all-docker \
  --root "$HOME/cc-phase2-lab"
```

The installer checks prerequisites and presents guided questions.
On this dedicated VM, select automatic installation when it offers required Docker and Compose dependencies.
Read the license and select acceptance only if you agree.

Use these answers when the corresponding prompts appear:

| Question                                         | Answer                                      |
| ------------------------------------------------ | ------------------------------------------- |
| Release mode                                     | `candidate`                                 |
| Candidate acknowledgment                         | `candidate-lab`                             |
| Installation project or namespace                | `cc-phase2-lab`                             |
| Generate a self-signed lab certificate           | `yes`                                       |
| Public HTTPS URL                                 | `https://localhost:8443`                    |
| HTTPS bind IPv4 address                          | `127.0.0.1`                                 |
| Readiness connection IPv4 address                | `127.0.0.1`                                 |
| Lab prerequisite exceptions                      | `none`                                      |
| Application phase                                | `2`                                         |
| Sign-in provider                                 | `google`                                    |
| Google client import                             | `browser`                                   |
| Absolute session lifetime                        | `3600` seconds for this lab.                |
| Idle session lifetime                            | `300` seconds for this lab.                 |
| Storage capacities and internal service settings | Accept the defaults for this all-Docker VM. |
| Responsible operator labels                      | Your name or the displayed lab default.     |

Use candidate mode for this laboratory test.
It preserves signature checks and records that full district acceptance remains open.
The shorter lab session limits make expiry practical to test. They are not a production session recommendation.

The installer creates PostgreSQL, Redis, Kestra, worker, API, frontend, and edge services.
It generates the internal credentials.
When the terminal prints the Google setup address, complete these steps on Windows:

1. Open the printed setup address through the SSH tunnel.
2. Enter the private pairing code shown in the Ubuntu terminal.
3. Compare the displayed callback URI with your Google client's registered URI.
4. Select your downloaded `client_secret.json` in the upload form.
5. Submit the file and wait for confirmation.
6. Return to the Ubuntu terminal and complete the remaining questions.

The installer extracts and protects the client ID and secret.
The upload listener closes after success. Its pairing code expires after fifteen minutes.
Keep pairing codes and credential files out of screenshots and reports.

At `5 / 5  Check configuration and start services`, watch the activity messages.
The installer reports its current task and elapsed time every five seconds while work remains pending.
A changed task produces a new message. A prompt pauses the activity timer.
Record a failure if startup stays silent while work continues without a prompt.

**Expected result:** Installation reports `ready` and the application URL.
Continue with administrator enrollment below while the installation command remains active.

If a prerequisite fails, follow its named corrective instruction and repeat the same command.
Do not create a different installation directory to conceal the failure.

**6. Enroll the first administrator during installation**

Leave the installation command running after service readiness.
The installer prints an administrator setup address and a new private pairing code.
This code differs from the Google upload code. It expires after ten minutes.

1. Open the printed administrator setup address on Windows.
2. Handle the certificate warning for this isolated localhost lab as described in step 7.
3. Enter the new pairing code.
4. Sign in with the Google account that will become the first administrator.
5. Return to the Ubuntu terminal.
6. Inspect the verified account shown there.
7. Type `yes` only when it identifies the intended administrator.
8. Wait for the browser to confirm enrollment.
9. Select **Sign in to Campus Commander**.

**Expected result:** The installer grants access to the verified account after your terminal confirmation.
You do not need a Google account identifier lookup or a separate enrollment command.
If the account is wrong, decline confirmation and resume installation to retry.
If setup expires, use the resume command in step 10 to obtain a new pairing code.

**7. Open the application on Windows**

Keep the SSH tunnel open. In your Windows browser, visit:

```text
https://localhost:8443
```

The installer created a self-signed certificate for this private lab.
Your browser will report an untrusted certificate unless you separately trust that certificate.
For this isolated test, continue through the browser's certificate warning only for this exact localhost address.
Do not disable browser certificate verification globally.
Record the certificate warning as a lab limitation. This does not test district browser trust.
If browser policy prevents continuation, use an administrator-approved trusted certificate instead.

Select **Sign in to Campus Commander** and choose the Google account enrolled in step 6.
You should reach **Your account**.
The footer's build should identify revision `8b8d5a1`. The version can retain the `phase-2-candidate` image label.

**8. Complete the first browser test**

Record Pass or Fail for every row. A blank result is not a pass.
Run the service checks one at a time. They use synthetic data and do not administer your Google domain.

| Test                  | What to do                                                                                   | Expected result                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Sign-in               | Sign in with the enrolled Google account.                                                    | Your account page opens.                                                             |
| Identity              | Read the account information.                                                                | It identifies your enrolled application account.                                     |
| Available pages       | Inspect navigation.                                                                          | Your account and Diagnostics are available. Later-phase management pages are absent. |
| Service status        | Open Diagnostics and select Refresh connections.                                             | Connections report Ready.                                                            |
| Database              | Select Check PostgreSQL.                                                                     | The check passes.                                                                    |
| Cache                 | Select Check Redis.                                                                          | The check passes.                                                                    |
| Worker task           | Select Check Kestra.                                                                         | The check passes after worker execution.                                             |
| File storage          | Select Check Artifact storage.                                                               | The check passes after verified publication and readback.                            |
| Repeatability         | Repeat all four checks.                                                                      | Each check passes again.                                                             |
| Support reference     | Expand Support reference beneath a result.                                                   | A correlation identifier appears. No password or token appears.                      |
| Theme                 | Choose dark, then reload. Repeat with light.                                                 | Each explicit theme choice persists.                                                 |
| Navigation preference | Collapse navigation and reload.                                                              | The preference persists.                                                             |
| Session restoration   | Reload, then visit Your account and Diagnostics.                                             | You remain signed in before expiry.                                                  |
| Keyboard              | Use Tab, Shift+Tab, Enter, and Escape through navigation and menus.                          | Controls work and focus remains visible.                                             |
| Zoom                  | Set browser zoom to 200 percent.                                                             | Text and controls remain usable without clipped primary actions.                     |
| Sign-out              | Open the user menu and select Sign out.                                                      | The sign-in page opens.                                                              |
| Protected page        | After sign-out, open `https://localhost:8443/diagnostics` directly and reload.               | The application requests sign-in.                                                    |
| Protected API         | After sign-out, open `https://localhost:8443/api/auth/session` directly.                     | An unauthorized response appears. No signed-in identity appears.                     |
| Unapproved identity   | In a private browser window, sign in with another Workspace account that you did not enroll. | Campus Commander denies application access.                                          |

A Google session can remain active after Campus Commander sign-out.
Immediate Google account selection or automatic Google authentication does not mean the application logout failed.
The protected-page check verifies the application session boundary.

**9. Test a service restart and an outage**

Sign in again. Select a theme and complete all four Diagnostics checks.
On Ubuntu, restart only this installation's API:

```bash
sudo docker compose -f "$HOME/cc-phase2-lab/docker-compose.json" -p cc-phase2-lab restart api
```

Refresh the browser after the API recovers.
Your session and theme should remain available. Repeat all four checks.

Now stop the API:

```bash
sudo docker compose -f "$HOME/cc-phase2-lab/docker-compose.json" -p cc-phase2-lab stop api
```

Select Refresh connections in the browser.
Expect an unavailable or error state. Existing observations must not represent fresh successful checks.
Capture the visible result, then start the API again:

```bash
sudo docker compose -f "$HOME/cc-phase2-lab/docker-compose.json" -p cc-phase2-lab start api
```

Retry Refresh connections and all four checks after recovery.
Stop here and report the failure if recovery does not restore the application.

**10. Test session expiry and VM restart**

For idle expiry, sign in and close every Campus Commander browser tab.
Wait at least six minutes. Reopen the application.
The application should request sign-in because the lab idle limit is five minutes.
Google can authenticate you again without requesting your Google password.

Then test VM recovery:

1. Sign in and select a theme.
2. Run `sudo reboot` on Ubuntu. The SSH connection will close.
3. Wait for Ubuntu to restart.
4. Check the VM address in its console. DHCP can assign a different address.
5. Repeat the SSH tunnel command with the current VM address.
6. Run this command on Ubuntu:

```bash
sh "$HOME/cc-test-tools/install.sh" --root "$HOME/cc-phase2-lab" --command resume
```

7. Sign in again if requested. Redis sessions are disposable across a full restart.
8. Verify your identity and saved theme. Repeat all four Diagnostics checks.

**Expected result:** The same installation recovers with its saved application identity and preferences.
The installer reuses its cached release. It does not silently upgrade the installation.
It must retain the imported Google credentials and existing administrator enrollment.
Completed enrollment must not request a new initial administrator.

For disk-full recovery, first restore free space and check `df -h /`.
Repeat the same resume command with the same installation directory.
Preserve the installation files and Docker volumes while recovering.

**11. Test uninstall and resume**

Complete the browser checks before this step. Record your account and theme for comparison.
Run this command on Ubuntu:

```bash
sh "$HOME/cc-test-tools/install.sh" --root "$HOME/cc-phase2-lab" --uninstall
```

First enter `cancel` at the confirmation prompt.
**Expected result:** The installer cancels uninstall. The application remains available.

Repeat the command. Enter `cc-phase2-lab` when the installer asks for the installation name.
**Expected result:** Activity messages continue until the application services stop and their containers are removed.
The application becomes unavailable. The installer preserves data, credentials, and configuration.

Restore the application services:

```bash
sh "$HOME/cc-test-tools/install.sh" --root "$HOME/cc-phase2-lab" --command resume
```

Sign in with the same administrator. Verify the saved theme and repeat all four Diagnostics checks.
**Expected result:** The same application account remains enrolled. Setup does not request credential import or initial enrollment again.

**12. Test the update option**

First test selection of the release that is already installed:

```bash
sh "$HOME/cc-test-tools/install.sh" \
  --root "$HOME/cc-phase2-lab" \
  --release phase-2-candidate-8b8d5a15c756 \
  --update
```

**Expected result:** The installer reports `already-current`. It preserves the installation without requesting a recovery backup.
This checks the update entry point. It does not test a change between releases.

A release-change test needs a different verified Phase 2 release and a matching recovery backup.
Follow the [backup procedure](../../deployment/operations/README.md) to create and verify that backup before continuing.
That procedure requires stopped writers and a separately protected recovery key.
Resume services after backup and confirm readiness before starting the update test.
The update option verifies an existing backup. It does not create one.
If those prerequisites are incomplete, record the release-change test as **Not run**.

When the prerequisites are ready, replace `TARGET_RELEASE_TAG` with the agreed target release:

```bash
sh "$HOME/cc-test-tools/install.sh" \
  --root "$HOME/cc-phase2-lab" \
  --release TARGET_RELEASE_TAG \
  --update
```

1. Check the installed and target revisions displayed by the installer.
2. Enter the absolute directory of the verified recovery backup.
3. Enter `cancel` on the first attempt.
4. Confirm that your application still uses the installed revision.
5. Repeat the command with the same target and backup.
6. Type `update` to confirm the release change.
7. Wait for activity messages and final readiness.
8. Sign in and verify the target build revision, existing account, and saved theme.
9. Repeat all four Diagnostics checks.

After interruption, run the resume command in step 10.
Preserve `setup-update.json`, the `updates` directory, and both cached releases until recovery completes.
Record the source release, target release, and recovery result separately from the fresh installation test.

**13. Record results and stop the lab**

Use this format for each failure:

```text
Release: phase-2-candidate-8b8d5a15c756
Test:
Expected:
Observed:
Time and timezone:
Support reference, if displayed:
Screenshot of the application result:
```

Share application screenshots and correlation identifiers. Keep Google secrets, cookies, tokens, and private configuration files out of reports.
This status command is useful when services fail:

```bash
sh "$HOME/cc-test-tools/install.sh" --root "$HOME/cc-phase2-lab" --command status
```

To stop the lab while preserving its data:

```bash
sudo docker compose -f "$HOME/cc-phase2-lab/docker-compose.json" -p cc-phase2-lab stop
```

Use the resume command in step 10 to continue later.
Do not erase volumes while you still need the test evidence or saved account.

**Troubleshooting**

| Symptom                                       | First check                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SSH fails                                     | Check the VM address, virtual switch, and `sudo systemctl status ssh` in the VM console.                         |
| The browser cannot reach localhost            | Keep the SSH tunnel open. Check that Windows port 8443 is free.                                                  |
| Signature verification fails                  | Keep the exact release and installer revision. Record the named error before continuing.                         |
| Storage preflight fails                       | Check `df -h /`. Confirm Ubuntu uses the intended virtual disk capacity.                                         |
| Time synchronization fails                    | Check `timedatectl status`. Let synchronization complete before repeating installation.                          |
| Google reports redirect_uri_mismatch          | Compare the registered URI with `https://localhost:8443/api/auth/callback`, including scheme, port, and path.    |
| Google blocks the app                         | Check the project's audience and Workspace app-access policy with your administrator.                            |
| Google succeeds but application sign-in fails | Check the selected Google account, uploaded Web client JSON, callback URI, and terminal enrollment confirmation. |
| Administrator enrollment fails                | Check the pairing expiry and terminal confirmation. Resume setup. Existing enrollment must remain intact.        |
| A Diagnostics check fails                     | Record its message and support reference. Verify recovery before recording a pass.                               |

This recipe covers guided all-Docker onboarding, application behavior, and the maintenance checks listed above.
Hybrid services, Kubernetes, isolated backup restore, and Phase 1 upgrades require separate environment tests.
Use the [Phase 2 installer procedure](../../deployment/installer/PHASE-2.md) and [operator recovery procedure](../../deployment/bootstrap/APPLICATION-ACCESS.md) for those later sessions.
Consult the [target release](https://github.com/CampusCommander/campus-commander/releases/tag/phase-2-candidate-8b8d5a15c756) for published evidence and its limits.
