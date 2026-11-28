# Try Campus Commander at your school

Campus Commander is a web application for Google Workspace administrators.
It manages ChromeOS devices and Google users in bulk, and it records every change as a job.

This guide installs one evaluation copy on one Ubuntu machine.
It then connects that copy to your Google Workspace organization.
It assumes that you have Google Workspace super administrator access and Linux command-line experience.
For a lasting installation, use [Install on one server](single-server.md), [Install with your existing services](existing-services.md), or [Install on Kubernetes](kubernetes.md).

## Contents

- [Read this first](#read-this-first)
- [What you need](#what-you-need)
- [Step 1. Prepare the Ubuntu machine](#step-1-prepare-the-ubuntu-machine)
- [Step 2. Choose how your browser reaches the application](#step-2-choose-how-your-browser-reaches-the-application)
- [Step 3. Create a Google Cloud project](#step-3-create-a-google-cloud-project)
- [Step 4. Create the Google sign-in client](#step-4-create-the-google-sign-in-client)
- [Step 5. Create the service account](#step-5-create-the-service-account)
- [Step 6. Run the installer](#step-6-run-the-installer)
- [Step 7. Make yourself the first administrator](#step-7-make-yourself-the-first-administrator)
- [Step 8. Connect your Google Workspace organization](#step-8-connect-your-google-workspace-organization)
- [Step 9. Try the application](#step-9-try-the-application)
- [Check, restart, and remove the installation](#check-restart-and-remove-the-installation)
- [Troubleshooting](#troubleshooting)

## Read this first

**This is an evaluation build.**
The installer installs the newest signed review build.
Review builds are candidates. They are not production releases.
Install each new review build on a fresh machine.
Do not keep data in an evaluation installation that you need later.

**Some actions change Google Workspace.**
Reading users and devices never changes Google.
These actions write to your Google Workspace organization:

| Area    | Actions that change Google                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Devices | Update device fields, move to an organizational unit, Reboot, Disable, Re-enable, Wipe user data, Powerwash, Deprovision |
| Devices | Import from a CSV file                                                                                                   |
| Users   | Create, edit, or delete a custom attribute category                                                                      |
| Users   | Set custom attribute values on the details page, in the grid, and with **Bulk Actions** > **Set attributes**             |

Powerwash and Deprovision cannot be undone.
Use a test organizational unit, a few test users, and a test custom attribute category while you evaluate.
A bulk action shows a review step before it starts its job.
A single change in the grid or on a details page saves at once.

## What you need

| Item           | Requirement                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Machine        | A physical machine or a virtual machine with Ubuntu 24.04 LTS or Debian 12 or later                                                |
| Processor      | 64-bit x86 (amd64). ARM machines are not supported.                                                                                |
| Memory         | At least 4 GB of RAM. The installer checks for 3.2 GB: 2.7 GB for the services and 0.5 GB for the system.                          |
| Disk           | At least 40 GB free. The four default data volumes reserve 10 GB each.                                                             |
| Network        | Outbound HTTPS to `github.com`, `api.github.com`, `ghcr.io`, `nodejs.org`, `download.docker.com`, your package mirrors, and Google |
| Linux account  | A normal user account with `sudo` rights                                                                                           |
| Clock          | Network time synchronization turned on                                                                                             |
| Google account | A super administrator account of your Google Workspace organization                                                                |
| Google Cloud   | Permission to create a Google Cloud project in your organization                                                                   |
| Workstation    | A desktop browser. For a remote machine, also an SSH client.                                                                       |

You do not need to install Docker, Docker Compose, Node.js, or Git first.
The installer offers to install what it needs.

## Step 1. Prepare the Ubuntu machine

Sign in to the machine as your normal user.
Run each command below and compare the result.

1. Check the processor type:

   ```sh
   uname -m
   ```

   The result must be `x86_64`.

2. Check the operating system:

   ```sh
   grep PRETTY_NAME /etc/os-release
   ```

   The result must name Ubuntu 24.04 or Debian 12 or later.

3. Check memory and free disk space:

   ```sh
   free -h
   df -h ~ /var/lib
   ```

   The `total` memory must be at least 4 GB.
   Docker keeps the data volumes under `/var/lib/docker`.
   Each disk in the `df` output needs at least 40 GB in the `Avail` column.

4. Check the clock:

   ```sh
   timedatectl
   ```

   The line `System clock synchronized` must read `yes`.
   If it reads `no`, turn on network time and check again after one minute:

   ```sh
   sudo timedatectl set-ntp true
   timedatectl
   ```

5. Update the system packages and install `curl`:

   ```sh
   sudo apt update
   sudo apt upgrade -y
   sudo apt install -y curl
   ```

## Step 2. Choose how your browser reaches the application

The evaluation installation listens only on the machine itself, at `https://localhost:8443`.
Google sign-in accepts `localhost` as a return address without a public DNS name.
The installer also creates a self-signed certificate for `localhost`.
A real host name needs a DNS name and a certificate. This guide does not cover that path.

Pick the option that matches your machine.

**Option A. The browser runs on the same machine.**
Use this option for Ubuntu Desktop. Open `https://localhost:8443` in a browser on that machine.

**Option B. The machine is a remote server or a virtual machine.**
Forward two ports from your workstation through SSH.
Run this command on your workstation. It works in Windows PowerShell, macOS Terminal, and Linux:

```sh
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:8443 -L 127.0.0.1:8765:127.0.0.1:8765 YOUR_USER@SERVER_ADDRESS
```

Replace `YOUR_USER` and `SERVER_ADDRESS` with your account and the machine's address.
Keep this SSH session open through Steps 6, 7, and 8.
Run the installer inside this SSH session.
Then open `https://localhost:8443` in the browser on your workstation.

| Port | Use                                                                          |
| ---- | ---------------------------------------------------------------------------- |
| 8443 | The Campus Commander application                                             |
| 8765 | A temporary installer page that imports your Google sign-in client in Step 6 |

## Step 3. Create a Google Cloud project

One project holds the sign-in client and the service account.

1. Open [Google Cloud console](https://console.cloud.google.com) and sign in with an account of your school's Google Workspace organization.
   A personal Gmail account cannot create the Internal sign-in client of Step 4.
2. Select the project list at the top of the page, then select **New project**.
3. Enter a project name, for example `campus-commander-trial`.
4. Check that **Organization** shows your school's organization. Select **Create**.
5. Select the new project in the project list. Every later Cloud console step uses this project.

## Step 4. Create the Google sign-in client

People sign in to Campus Commander with their Google accounts.
This client handles that sign-in only. It gives no access to Gmail, Drive, or user administration.

1. Open [Google Auth Platform, Branding](https://console.cloud.google.com/auth/branding). Select **Get started** if the page shows it.
2. Enter an app name, for example `Campus Commander trial`, and select your email as the support email.
3. For **Audience**, select **Internal**. Internal limits sign-in to accounts of your organization.
4. Enter your email as the contact email. Accept the policy and select **Create**.
5. Open [Google Auth Platform, Clients](https://console.cloud.google.com/auth/clients) and select **Create client**.
6. For **Application type**, select **Web application**. Enter a name, for example `Campus Commander trial`.
7. Under **Authorized redirect URIs**, select **Add URI** and enter exactly:

   ```text
   https://localhost:8443/api/auth/callback
   ```

8. Select **Create**. In the dialog, select **Download JSON**.
9. Keep the downloaded file on the workstation where your browser runs. You upload it through the browser in Step 6.

Treat this file as a password. It contains the client secret.

## Step 5. Create the service account

Campus Commander reads and writes Google data in the background through a service account.
The service account acts as one of your administrators through domain-wide delegation.
You authorize the delegation in Step 8, where Campus Commander fills in the details for you.

1. Open **APIs & Services** > **Library** in the Cloud console. Search for **Admin SDK API**, open it, and select **Enable**.
2. Enable these APIs too if you plan to try the matching features:

   | API                   | Feature                                       |
   | --------------------- | --------------------------------------------- |
   | Chrome Management API | Device telemetry, such as battery health      |
   | Google Drive API      | Device export and import through Google Drive |
   | Google Sheets API     | Device export and import through Google Drive |
   | Google Picker API     | Device export and import through Google Drive |

3. Open **IAM & Admin** > **Service Accounts** and select **Create service account**.
4. Enter a name, for example `campus-commander`. Select **Create and continue**.
5. Grant no project role. Select **Continue**, then **Done**. Delegation gives the account its access, not project roles.
6. Open the new service account and select the **Keys** tab.
7. Select **Add key** > **Create new key**, select **JSON**, and select **Create**. The browser downloads the key file.

Treat the key file as a password. Anyone with the file and the delegation acts as your delegated administrator.
Keep it on your workstation. You upload it through the browser in Step 8.

If Google refuses to create the key, read [Service account key creation is blocked](#service-account-key-creation-is-blocked).

## Step 6. Run the installer

Run the installer as your normal user, not with `sudo`.
The installer asks for your `sudo` password in the terminal when a step needs it.
It never reads or stores that password.
Downloads and configuration stay under your user account.

1. Download the installer:

   ```sh
   cd ~
   curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh -o campus-commander-install.sh
   ```

2. Start the evaluation installation:

   ```sh
   sh campus-commander-install.sh --profile all-docker --qualification
   ```

   `--profile all-docker` runs every service in Docker on this machine.
   `--qualification` selects the disposable evaluation mode.

3. The installer checks the machine, then downloads and verifies the signed release.
   When a prerequisite is missing, it offers **Install automatically**, **Show instructions**, or **Cancel**.
   Select **Install automatically**. The installer explains each system change and asks for consent first.

4. Answer the questions. Press Enter to accept a default in brackets. Use these answers:

   | Question                                                      | Answer                                            |
   | ------------------------------------------------------------- | ------------------------------------------------- |
   | License                                                       | Read it and accept it                             |
   | `Private installation directory`                              | Press Enter (`/home/YOUR_USER/.campus-commander`) |
   | `Type candidate-lab to acknowledge ...`                       | `candidate-lab`                                   |
   | `Installation project or namespace`                           | Press Enter (`cc-lab`)                            |
   | `Generate a self-signed lab certificate (yes/no)`             | `yes`                                             |
   | `Public HTTPS URL`                                            | Press Enter (`https://localhost:8443`)            |
   | `HTTPS bind IPv4 address`                                     | Press Enter (`127.0.0.1`)                         |
   | `Readiness connection IPv4 address`                           | Press Enter (`127.0.0.1`)                         |
   | `Lab prerequisite exceptions, comma-separated names, or none` | `none`                                            |
   | `Application phase (1, 2, or 3)`                              | Press Enter (`3`)                                 |
   | `Sign-in provider (google/oidc)`                              | Press Enter (`google`)                            |
   | `Google client import (browser/file)`                         | Press Enter (`browser`)                           |
   | Session lifetimes, database names, storage sizes, and labels  | Press Enter for each                              |

5. Import the sign-in client of Step 4.
   The installer prints a Google setup address and a private pairing code.
   Open the address in your browser and enter the pairing code.
   Check that the redirect URI on the page reads `https://localhost:8443/api/auth/callback`.
   Select the JSON file of Step 4 in the upload form, then import it.
   The pairing code expires after fifteen minutes.

6. The installer starts the services and prints its progress.
   The first start downloads the application images and takes several minutes.
   Success prints `ready` and the application address.

The installer also prints the path of a private bootstrap credential file. Keep that file private.

## Step 7. Make yourself the first administrator

After `ready`, the installer prints an administrator setup address and a second pairing code.
The setup address ends with `/setup`. This code expires after ten minutes.

1. Open the browser profile that you use for your school Google account.
   The first pairing request binds the code to that browser profile.
2. Open the administrator setup address.
   The browser warns about the self-signed certificate. This warning is expected for the evaluation certificate.
   In Chrome, select **Advanced**, then **Proceed to localhost**.
3. Enter the administrator pairing code.
4. Sign in with your Google Workspace administrator account.
5. Return to the terminal. Check the account that the installer shows, and type `yes`.
   Any other answer cancels the enrollment.
6. The browser reports completion. Select **Sign in to Campus Commander**.

If a code expires, press Ctrl+C in the terminal and resume the installation.
[Check, restart, and remove the installation](#check-restart-and-remove-the-installation) gives the command.

## Step 8. Connect your Google Workspace organization

> **Known issue in release `phase-3-lab-20fedf388811`.** Setup does not create the Google connection encryption key.
> The page then reports "Google credentials are not configured on this installation." at the service account import.
> A fix is in progress. Do this step on the first release that contains the fix.

1. In Campus Commander, select **Google connection** in the navigation.
2. Under **Import a service account**, select **Choose service-account file**. Select the key file of Step 5.
   **Service account client ID** shows the numeric client ID of the key.
3. In **Delegated administrator email**, enter the email of a super administrator of your organization.
   Campus Commander acts with that administrator's privileges.
4. Under **Configure Google delegation**, select **Open domain-wide delegation in the Google Admin console**.
   Google Admin opens with the client ID and the scopes filled in.
   Check the client ID, then select **Authorize**.
   **Authorize** replaces any earlier scope list of that client ID.
5. Return to Campus Commander and select **Check credentials**.
   Google applies a delegation change after a short delay.
   If the check reports a delegation failure, wait two minutes and select **Check credentials** again.
6. **Review Google customer** shows the customer ID and the primary domain that Google returned.
   Compare them with **Account** > **Account settings** > **Profile** in the [Google Admin console](https://admin.google.com).
7. Select **I verified this customer ID and primary domain**, then **Confirm customer**.
   The page shows **Customer connected**.
8. Select **Check Google access**. **Diagnostics** opens and shows each Google capability with its status.
   The user capabilities need the four user scopes.
   Device telemetry also needs the Chrome Management API of Step 5.

To authorize the delegation by hand instead of with the link in step 4:

1. In the [Google Admin console](https://admin.google.com), open **Security** > **Access and data control** > **API controls**.
2. Under **Domain-wide delegation**, select **Manage domain-wide delegation**, then **Add new**.
3. Paste the client ID that Campus Commander shows. Select **Copy client ID** to copy it.
4. Paste the scopes. Select **Copy scopes** in Campus Commander to copy them as one comma-separated line.
5. Select **Authorize**.

Campus Commander requests these scopes:

| Scope                                                                      | Use                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `https://www.googleapis.com/auth/admin.directory.customer.readonly`        | Read the customer ID                            |
| `https://www.googleapis.com/auth/admin.directory.domain.readonly`          | Read the domains                                |
| `https://www.googleapis.com/auth/admin.directory.orgunit.readonly`         | Read the organizational units                   |
| `https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly` | Read ChromeOS devices                           |
| `https://www.googleapis.com/auth/chrome.management.telemetry.readonly`     | Read device telemetry                           |
| `https://www.googleapis.com/auth/admin.directory.device.chromeos`          | Change ChromeOS devices and send commands       |
| `https://www.googleapis.com/auth/drive.file`                               | Read and write export and import files in Drive |
| `https://www.googleapis.com/auth/admin.directory.user.readonly`            | Read users                                      |
| `https://www.googleapis.com/auth/admin.directory.userschema.readonly`      | Read custom attribute categories                |
| `https://www.googleapis.com/auth/admin.directory.userschema`               | Change custom attribute categories              |
| `https://www.googleapis.com/auth/admin.directory.user`                     | Change custom attribute values of users         |

## Step 9. Try the application

| Page                                 | What to try                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Users**                            | Browse and filter users, open a user's details, and show custom attribute columns from **Columns** |
| **Users**, **Custom attributes** tab | Read your categories. Create a test category to try the editor. This step changes Google.          |
| **Users**, user details              | Select **Edit** on **Custom attributes** to set values on one test user. This step changes Google. |
| **Users**, grid                      | Edit attribute cells of test users, then select **Save changes**. This step changes Google.        |
| **Users**, **Bulk Actions**          | Select test users, then **Set attributes**. This step changes Google.                              |
| **Devices**                          | Browse and filter devices, open device details, and read battery health                            |
| **Jobs**                             | Open the job of each change and read its result for each user or device                            |
| **Diagnostics**                      | Check the services and the Google access                                                           |

An organization without ChromeOS devices shows an empty **Devices** page. That result is correct.

## Check, restart, and remove the installation

Run these commands as your normal user on the installation machine.
Each command uses the installation directory of Step 6.

Show the readiness of the services:

```sh
sh ~/campus-commander-install.sh --root "$HOME/.campus-commander" --command status
```

Resume after an interruption, an expired pairing code, or a machine restart that left the application stopped:

```sh
sh ~/campus-commander-install.sh --root "$HOME/.campus-commander" --command resume
```

Remove the application services and keep the data, configuration, and credentials:

```sh
sh ~/campus-commander-install.sh --root "$HOME/.campus-commander" --uninstall
```

The installer shows the project name, `cc-lab`. Type it to confirm.
Run `--command resume` to start the services again with the kept data.

When the evaluation ends, remove Google access as well:

1. In the [Google Admin console](https://admin.google.com), open **Security** > **Access and data control** > **API controls** > **Manage domain-wide delegation**. Delete the entry of the service account client ID.
2. In the Cloud console, open **IAM & Admin** > **Service Accounts**. Delete the service account.
3. In the Cloud console, shut down the project to remove the sign-in client too.
4. Delete the downloaded key file and client file from your workstation.
5. Delete the virtual machine, or reinstall the operating system of the evaluation machine.

## Troubleshooting

### The installer stops at a prerequisite check

The final check names each failed requirement and its fix.

| Check                  | Fix                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `time-synchronization` | Run `sudo timedatectl set-ntp true`, then confirm with `timedatectl` (Step 1)          |
| `host-memory`          | Give the machine at least 4 GB of RAM                                                  |
| `storage-capacity`     | Free at least 40 GB in your home directory                                             |
| Architecture           | Use a 64-bit x86 machine. The release supports amd64 only.                             |
| Docker limits          | Use a virtual machine or a physical machine. A restricted container cannot run Docker. |

After the fix, resume the installation with the `--command resume` command above.

### Google shows `Error 400: redirect_uri_mismatch`

The sign-in client of Step 4 does not hold the exact return address.
Open the client in [Google Auth Platform, Clients](https://console.cloud.google.com/auth/clients).
Set **Authorized redirect URIs** to exactly `https://localhost:8443/api/auth/callback`, without a trailing slash.
Save, wait one minute, and sign in again.

### Google shows `Error 403: org_internal`

The sign-in client is Internal, and you signed in with an account outside your organization.
Sign in with an account of the organization that owns the Cloud project.

### The browser cannot open `https://localhost:8443`

- Option B of Step 2: check that the SSH session with both `-L` forwards is still open.
- Run the `--command status` command above. Each service must report ready.

### Check credentials reports a delegation failure

- Check that the Admin SDK API is enabled in the project of the service account (Step 5).
- Check that the delegation entry in Google Admin shows the same client ID as Campus Commander.
- Check that the delegated administrator email belongs to a super administrator.
- Wait two minutes after each change, then select **Check credentials** again.

### Service account key creation is blocked

Google Cloud organizations created on or after 2024-05-03 block service account keys by default.
The policy is **Disable service account key creation**.
Its constraint ID is `iam.disableServiceAccountKeyCreation` or `iam.managed.disableServiceAccountKeyCreation`.
A person with the **Organization Policy Administrator** role can allow keys for the evaluation project only:

1. Select the evaluation project. Open **IAM & Admin** > **Organization policies**.
2. Search for **Disable service account key creation** and open it.
3. Select **Manage policy**, then **Override parent's policy**.
4. Add a rule with **Enforcement** set to **Off**. Select **Set policy**.
5. Return to Step 5 and create the key.

## More information

- [Fresh installation guide](../testing/fresh-install-review.md)
- [Hosted installation guide](../../deployment/installer/HOSTED.md): download alternatives, containers, updates, and recovery
- [Application access guide](../../deployment/bootstrap/APPLICATION-ACCESS.md): sign-in providers and administrator recovery
- [Published releases](https://github.com/CampusCommander/campus-commander/releases)
