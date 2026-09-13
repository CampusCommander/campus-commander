**Phase 2 testing recipe: fresh Ubuntu and Google Workspace**

Start here after installing Ubuntu on your test VM.
Use your ordinary Ubuntu login with sudo access. Use your Windows computer for the browser and Google setup.
The reference platform is Ubuntu 24.04 LTS on Intel or AMD 64-bit hardware.
Allow 8 GB RAM and sufficient disk space. This recipe uses the all-Docker installation mode.

Test release: `phase-2-qualified-436d3b0698a5`.
This recipe preserves the procedure used for that release.
The [new guided onboarding procedure](../../deployment/installer/HOSTED.md#guided-google-setup-and-administrator-enrollment) requires updated installer and application images.
It replaces manual credential extraction, Playground lookup, and the separate enrollment script.
Source revision: `436d3b0698a54b3268e608d83524b0d5c7195a25`.
Its 42 CI jobs passed. Independent verification passed 1,391 files and fifteen profile reports.
Each new Google configuration and VM requires its own test.

The operator reported all tests passed on September 12, 2026, including resume after a full disk.
The [manual test record](phase-2-ubuntu-google-results-2026-09-12.md) preserves that result and the pending process notes.

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
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:8443 UBUNTU_USER@VM_IP
```

On the first connection, check the host fingerprint before accepting it.
The VM console can display its fingerprint with:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Enter the Ubuntu password. Keep this terminal open throughout browser testing.
Commands entered in this connected terminal now run on Ubuntu.

The tunnel connects Windows port 8443 to the application's private Ubuntu port 8443.
Your browser will use `https://localhost:8443`, even though the application runs inside the VM.
You do not need an application DNS record or a public application port for this recipe.

If PowerShell cannot find `ssh`, install Windows' OpenSSH Client optional feature.
If port 8443 is occupied on Windows, stop the program using that port before continuing.

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

8. Save the client ID and download its client JSON file.
9. Rename the downloaded file to `client_secret.json` in your Windows Downloads folder.

The application requests only `openid profile` for sign-in.
If Google asks you to declare data access, use OpenID and basic profile information.
This test does not require Gmail, Drive, Directory API scopes, a service account, or domain-wide delegation.
Leave JavaScript origins empty. This application exchanges the authorization code on its server.

If Internal is unavailable, check the project's organization before continuing.
Workspace app controls can require an administrator to permit the test OAuth client.

Google documents [consent setup](https://developers.google.com/workspace/guides/configure-oauth-consent) and [client creation](https://developers.google.com/workspace/guides/create-credentials).
Its [web-server flow documentation](https://developers.google.com/identity/protocols/oauth2/web-server) permits localhost test redirects and requires exact redirect matching.

**Expected result:** You have a client ID, a private client JSON file, and the exact redirect URI above.

**4. Identify the Google account that will become the first administrator**

Campus Commander requires Google's stable account identifier, called `sub`.
An email address is not a substitute. Google describes this identifier in its [OpenID reference](https://developers.google.com/identity/openid-connect/reference).

Use the intended administrator's Google account for the following lookup:

1. Open Google's [OAuth Playground](https://developers.google.com/oauthplayground/).
2. Select online access in its settings. Keep the default Google client and leave your own credentials disabled.
3. Enter `openid profile` in the custom scopes field.
4. Select **Authorize APIs** and choose the intended administrator account.
5. Complete Google's consent screen.
6. Select **Exchange authorization code for tokens**.
7. In Playground step 3, select `GET` and enter this request address:

```text
https://openidconnect.googleapis.com/v1/userinfo
```

8. Send the request. Copy only the response's `sub` value.
9. Keep that value as text, including every digit.

This lookup uses Google's Playground client to read your basic identity.
Google's `sub` identifies the same Google account across clients.
Do not copy access tokens, refresh tokens, or Playground credential links into chat or Jira.
If Workspace blocks Playground, ask your administrator for an approved way to retrieve your verified Google `sub`.
Do not substitute an email address or an unrelated directory field.

**5. Place the Google client secret on Ubuntu**

In your connected Ubuntu terminal:

```bash
umask 077
mkdir -p "$HOME/cc-test-inputs"
chmod 700 "$HOME/cc-test-inputs"
```

Open a second PowerShell tab on Windows. Replace both placeholders and copy the downloaded file:

```powershell
scp "$env:USERPROFILE\Downloads\client_secret.json" UBUNTU_USER@VM_IP:cc-test-inputs/google-client.json
```

Return to the Ubuntu terminal. Run this block to extract the secret without printing it:

```bash
chmod 600 "$HOME/cc-test-inputs/google-client.json"
python3 - <<'PY'
import json
from pathlib import Path
root = Path.home() / 'cc-test-inputs'
client = json.loads((root / 'google-client.json').read_text())['web']
secret = root / 'oidc-client'
with secret.open('x') as output:
    output.write(client['client_secret'])
secret.chmod(0o600)
print('Client ID:', client['client_id'])
print('Secret file:', secret)
PY
```

The command prints the client ID and file path. It does not print the secret.
Keep the printed client ID for setup.
If the secret file already exists, inspect your previous setup before replacing it.

**6. Download and verify the exact Phase 2 release**

Run these commands on Ubuntu:

```bash
mkdir -p "$HOME/cc-test-tools"
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/436d3b0698a54b3268e608d83524b0d5c7195a25/install.sh -o "$HOME/cc-test-tools/install.sh"
sh "$HOME/cc-test-tools/install.sh" --release phase-2-qualified-436d3b0698a5 --verify-only
```

**Expected result:** The installer reports that release signatures and file checksums passed.
It prints `Verified release:` followed by a private cache directory.
Stop at a verification failure. Do not remove verification flags or change image digests.

This step downloads the installer runtime privately. It does not install the application.

**7. Install the application**

Run on Ubuntu:

```bash
sh "$HOME/cc-test-tools/install.sh" \
  --release phase-2-qualified-436d3b0698a5 \
  --profile all-docker \
  --root "$HOME/cc-phase2-lab"
```

The installer checks prerequisites and presents guided questions.
On this dedicated VM, select automatic installation when it offers required Docker and Compose dependencies.
Read the license and select acceptance only if you agree.

Use these answers when the corresponding prompts appear:

| Question                                         | Answer                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Release mode                                     | `candidate`                                                                                  |
| Candidate acknowledgment                         | `candidate-lab`                                                                              |
| Installation project or namespace                | `cc-phase2-lab`                                                                              |
| Generate a self-signed lab certificate           | `yes`                                                                                        |
| Public HTTPS URL                                 | `https://localhost:8443`                                                                     |
| HTTPS bind IPv4 address                          | `127.0.0.1`                                                                                  |
| Readiness connection IPv4 address                | `127.0.0.1`                                                                                  |
| Lab prerequisite exceptions                      | `none`                                                                                       |
| Application phase                                | `2`                                                                                          |
| OIDC issuer HTTPS URL                            | `https://accounts.google.com`                                                                |
| OIDC client identifier                           | The client ID from step 5.                                                                   |
| Absolute session lifetime                        | `3600` seconds for this lab.                                                                 |
| Idle session lifetime                            | `300` seconds for this lab.                                                                  |
| Application authentication protected source file | Paste the absolute secret-file path printed in step 5. Do not type `$HOME` into this prompt. |
| Storage capacities and internal service settings | Accept the defaults for this all-Docker VM.                                                  |
| Responsible operator labels                      | Your name or the displayed lab default.                                                      |

Candidate mode is required even though this release passed automated profile qualification.
It preserves signature checks and records that full district acceptance remains open.
The shorter lab session limits make expiry practical to test. They are not a production session recommendation.

The installer creates PostgreSQL, Redis, Kestra, worker, API, frontend, and edge services.
It generates the internal credentials. Supply only the Google client-secret file when requested.
Do not substitute the Google secret for an internal service credential.

**Expected result:** Installation reports `ready` and the application URL.
Keep the printed bootstrap credential file private. It is not a Google sign-in password.

If a prerequisite fails, follow its named corrective instruction and repeat the same command.
Do not create a different installation directory to conceal the failure.

**8. Enroll the first application administrator**

The application does not automatically admit everyone in your Google domain.
Initialization grants access to exactly the Google identity you specify.

Run this on Ubuntu. Paste the `sub` from step 4 when prompted:

```bash
python3 - <<'PY'
import json
from pathlib import Path
print('Google sub for the initial administrator: ', end='', flush=True)
with open('/dev/tty') as terminal:
    subject = terminal.readline().strip()
if not subject or '@' in subject:
    raise SystemExit('Enter the Google sub, not an email address.')
path = Path.home() / 'cc-test-inputs' / 'access-request.json'
with path.open('x') as output:
    json.dump({
        'action': 'initialize',
        'issuer': 'https://accounts.google.com',
        'subject': subject,
        'displayName': 'Phase 2 test administrator'
    }, output)
path.chmod(0o600)
print('Enrollment request created.')
PY
```

Submit that request through the installation's migration service:

```bash
sudo docker compose \
  -f "$HOME/cc-phase2-lab/docker-compose.json" \
  -p cc-phase2-lab \
  run --rm --no-deps --interactive --no-tty database-migrate \
  node /app/deployment/bootstrap/application-access-cli.mjs \
  /run/config/profile.json /run/config/operator.json /dev/stdin \
  < "$HOME/cc-test-inputs/access-request.json"
```

**Expected result:** JSON containing a principal identifier and a correlation identifier.
Initialization succeeds only when no application principal exists. Do not repeat it after success.
Keep the principal identifier with your private test notes.

**9. Open the application on Windows**

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

Select **Sign in to Campus Commander** and choose the Google account enrolled in step 8.
You should reach **Your account**.
The footer's build should identify revision `436d3b0`. The version can retain the `phase-2-candidate` image label.

**10. Complete the first browser test**

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

**11. Test a service restart and an outage**

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

**12. Test session expiry and VM restart**

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

**13. Record results and stop the lab**

Use this format for each failure:

```text
Release: phase-2-qualified-436d3b0698a5
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

Use the resume command in step 12 to continue later.
Do not erase volumes while you still need the test evidence or saved account.

**Troubleshooting**

| Symptom                                       | First check                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SSH fails                                     | Check the VM address, virtual switch, and `sudo systemctl status ssh` in the VM console.                      |
| The browser cannot reach localhost            | Keep the SSH tunnel open. Check that Windows port 8443 is free.                                               |
| Signature verification fails                  | Keep the exact release and installer revision. Record the named error before continuing.                      |
| Storage preflight fails                       | Check `df -h /`. Confirm Ubuntu uses the intended virtual disk capacity.                                      |
| Time synchronization fails                    | Check `timedatectl status`. Let synchronization complete before repeating installation.                       |
| Google reports redirect_uri_mismatch          | Compare the registered URI with `https://localhost:8443/api/auth/callback`, including scheme, port, and path. |
| Google blocks the app                         | Check the project's audience and Workspace app-access policy with your administrator.                         |
| Google succeeds but application sign-in fails | Check the enrolled `sub`, selected Google account, client ID, secret file, and issuer.                        |
| Initialization fails                          | Check whether a principal already exists. Preserve the database and use the documented inspection procedure.  |
| A Diagnostics check fails                     | Record its message and support reference. Verify recovery before recording a pass.                            |

This first recipe covers a fresh all-Docker installation and manual application behavior.
Hybrid services, Kubernetes, isolated backup restore, and Phase 1 upgrades require separate environment tests.
Use the [Phase 2 installer procedure](../../deployment/installer/PHASE-2.md) and [operator recovery procedure](../../deployment/bootstrap/APPLICATION-ACCESS.md) for those later sessions.
The [current release](https://github.com/CampusCommander/campus-commander/releases/tag/phase-2-qualified-436d3b0698a5) contains their automated evidence and its limits.
