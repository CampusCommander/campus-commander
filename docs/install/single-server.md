# Install Campus Commander on one server

This guide installs Campus Commander on one Ubuntu server for daily use by your IT staff.
Every service runs in Docker on that server.
The services are the HTTPS edge, the web client, the API, the job workers, Kestra, PostgreSQL, and Redis.
It assumes Google Workspace super administrator access and Linux command-line experience.

## Contents

- [Choose a layout](#choose-a-layout)
- [Read this first](#read-this-first)
- [What you need](#what-you-need)
- [Step 1. Plan the address, DNS, certificate, firewall, and proxy](#step-1-plan-the-address-dns-certificate-firewall-and-proxy)
- [Step 2. Prepare the server](#step-2-prepare-the-server)
- [Step 3. Stage the certificate files](#step-3-stage-the-certificate-files)
- [Step 4. Create the Google sign-in client and service account](#step-4-create-the-google-sign-in-client-and-service-account)
- [Step 5. Run the installer](#step-5-run-the-installer)
- [Step 6. Make yourself the first administrator](#step-6-make-yourself-the-first-administrator)
- [Step 7. Connect your Google Workspace organization](#step-7-connect-your-google-workspace-organization)
- [Operate the installation](#operate-the-installation)
- [Troubleshooting](#troubleshooting)

## Choose a layout

| Layout                       | Guide                                                       | Use it when                                                                                        |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Trial                        | [Try Campus Commander](try-campus-commander.md)             | You want a disposable evaluation at `https://localhost:8443`                                       |
| One server                   | This guide                                                  | You want one machine to operate. This layout fits a single school and most districts.              |
| One server and your services | [Install with your existing services](existing-services.md) | Your district operates PostgreSQL, Redis, and NFS storage, and wants job workers on separate hosts |
| Kubernetes                   | [Install on Kubernetes](kubernetes.md)                      | Your district operates a Kubernetes cluster with shared storage and network policy enforcement     |

The project has not measured capacity for a number of users or devices.
Guided setup gives each service a fixed CPU and memory limit on every layout.
A larger server does not raise those limits.
Only the Kubernetes layout runs more than one API process.
A large district can start on one server and move to Kubernetes after a pilot.

## Read this first

**Every release is a review build.**
The project publishes review builds only. No accepted production release exists yet.

The installer installs the newest signed review build in candidate mode.
Candidate mode requires a project name that starts with `cc-`.
Treat the data in a review build as disposable. Install each new review build on a fresh server.

**Known issues in release `phase-3-lab-87410bf7d21b`:**

1. The release has no procedure to replace the HTTPS certificate of an installation.
   Use a certificate that stays valid for the whole review period.
2. The installer checks the HTTPS port as the account that runs it.
   A normal account cannot open a port below 1024, so the check fails for port 443.
   Run the installer as root for an address on port 443. [Step 5](#step-5-run-the-installer) gives the commands.

**Some actions change Google Workspace.**
Device commands, custom attribute categories, and custom attribute values write to your organization.
The trial guide lists each action in [Read this first](try-campus-commander.md#read-this-first).

## What you need

| Item          | Requirement                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Server        | A physical machine or a virtual machine with Ubuntu 24.04 LTS or Debian 12 or later                       |
| Processor     | 64-bit x86 (amd64) with at least 2 cores. The services request 1.5 cores in total.                        |
| Memory        | At least 4 GB. The installer checks for 3.2 GB. 8 GB lets every service reach its memory limit of 6.5 GB. |
| Disk          | At least 60 GB. The installer checks 40 GB free for the data volumes. Docker images need the rest.        |
| Address       | A fixed IPv4 address on the server                                                                        |
| Host name     | One DNS name for Campus Commander, for example `campus.district.org`                                      |
| Certificate   | A TLS certificate and its private key for that host name                                                  |
| Clock         | Network time synchronization turned on                                                                    |
| Linux account | Root access through `sudo`                                                                                |
| Google        | A super administrator account, and permission to create a Google Cloud project in your organization       |
| Workstation   | A desktop browser and an SSH client                                                                       |

The installer installs Docker Engine, Docker Compose, and its other tools when they are missing.
It requires Docker Engine 29.7.2 or later within version 29, and Docker Compose 5.5.0 or later within version 5.

## Step 1. Plan the address, DNS, certificate, firewall, and proxy

Make these decisions before you install. The installer checks the DNS name and the certificate.

### Choose intranet access or internet access

| Decision         | Intranet access                                       | Internet access                                                      |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Who connects     | Staff on district networks and on the district VPN    | Staff on any network                                                 |
| DNS record       | Internal DNS only                                     | Public DNS, and internal DNS for staff inside the district           |
| Server address   | A private address                                     | A private address behind a firewall with a public address            |
| Certificate      | A public CA certificate, or a district CA certificate | A public CA certificate                                              |
| Inbound firewall | TCP 443 from staff networks only                      | TCP 443 from the internet, or from the address ranges that you allow |

Google sign-in works for both choices.
Google sends the browser back to Campus Commander. Google never opens a connection to the server.
The server only needs outbound HTTPS to Google.

Intranet access is the smaller exposure. Start with it unless staff must work from home without the VPN.

### Choose the host name

Use one DNS name under a domain that your district owns, for example `campus.district.org`.

- Use a domain with a public top-level domain, such as `.org` or `.us`. Google rejects sign-in return addresses under other suffixes, such as `.local`.
- Do not use an IP address. Google rejects an IP address in a return address.
- The application address is `https://` and the host name, with no path. For example: `https://campus.district.org`.
- Port 443 is the default. You can also use another port, such as `https://campus.district.org:8443`. Staff then type the port.

The name only needs to resolve inside your district for intranet access.

### Create the DNS record

**Intranet access.**
Create an A record in your internal DNS zone for the host name. Point it at the server address.
In a split DNS setup, create the record in the internal view only.

**Internet access.**
Create a public A record that points at the public address of your firewall.
Forward TCP 443 on that address to the server address.
Also create an internal A record that points at the server address. Staff inside the district then connect directly.

The server itself must resolve the name. The installer checks it. Test it on the server:

```sh
getent hosts campus.district.org
```

The command prints the address of the record.

### Get the certificate

The certificate must meet these rules. The installer checks the first three.

- Its Subject Alternative Name list holds the host name. A wildcard certificate, such as `*.district.org`, also works.
- It is valid now.
- Its private key matches the certificate.
- The certificate file is PEM. It holds the server certificate first, then each intermediate certificate.
- The private key file is PEM without a passphrase.

Choose the certificate source:

| Source                                                       | Browser trust                             | Installer answer for the trust question |
| ------------------------------------------------------------ | ----------------------------------------- | --------------------------------------- |
| A public CA, such as your commercial provider                | Every browser trusts it. No client setup. | `system-ca`                             |
| A district CA, such as Active Directory Certificate Services | Every staff browser must trust your CA    | `private-ca`                            |

A public CA can also issue a certificate for an intranet-only name. The CA then validates the name through a DNS record.
For a district CA, push the CA certificate to managed browsers first.
For ChromeOS and managed Chrome, open the [Google Admin console](https://admin.google.com) and go to **Devices** > **Networks** > **Certificates**.
For Windows, use a Group Policy object.

Check the certificate files before the installation:

```sh
openssl x509 -in campus.crt -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in campus.crt -noout -pubkey | openssl sha256
openssl pkey -in campus.key -pubout | openssl sha256
```

The first command shows the names and the dates. The last two commands must print the same hash.

### Plan the firewall

The server accepts these inbound connections:

| From                                                | Port                                 | Use              |
| --------------------------------------------------- | ------------------------------------ | ---------------- |
| Staff networks, or the internet for internet access | TCP 443, or the port of your address | Campus Commander |
| Administrator workstations                          | TCP 22                               | SSH              |

Every other service listens only on internal Docker networks. Do not open other inbound ports.

The server makes these outbound connections:

| Destination                                                                                                                          | Port           | When         | Use                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------ | ------------------------------------ |
| `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`                                                                 | TCP 443        | Always       | Google sign-in                       |
| `admin.googleapis.com`, `chromemanagement.googleapis.com`, `sheets.googleapis.com`, `www.googleapis.com`                             | TCP 443        | Always       | Google Workspace data and jobs       |
| `github.com`, `api.github.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | TCP 443        | Installation | Installer and release files          |
| `ghcr.io`, `pkg-containers.githubusercontent.com`                                                                                    | TCP 443        | Installation | Campus Commander images              |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`                                                         | TCP 443        | Installation | PostgreSQL, Redis, and Kestra images |
| `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev`                                                                                    | TCP 443        | Installation | Signature verification               |
| `download.docker.com`, `nodejs.org`, your Ubuntu package mirror                                                                      | TCP 443 and 80 | Installation | Docker packages and installer tools  |
| Your DNS servers                                                                                                                     | 53             | Always       | Name resolution                      |
| Your time servers                                                                                                                    | UDP 123        | Always       | Time synchronization                 |

The browsers of your staff also connect to `accounts.google.com`, `apis.google.com`, `docs.google.com`, `sheets.googleapis.com`, and `www.googleapis.com`.

Three rules apply to the outbound path:

- **No outbound proxy.** This release has no HTTP proxy setting. The server needs direct outbound HTTPS to Google.
- **No TLS inspection.** The containers trust public CAs only. Exempt the server from the TLS inspection of your web filter.
- **Shared address limits.** Docker Hub limits anonymous image pulls for each public address. A district with one shared address can reach that limit during installation.

**Docker and the host firewall.**
Docker publishes the HTTPS port through its own firewall rules. A `ufw` rule does not block a port that Docker publishes.
Restrict the sources of port 443 on the network firewall in front of the server.
To restrict the sources on the server itself, add rules to the `DOCKER-USER` chain.
Replace `eth0` with the server interface and `10.20.0.0/16` with your staff networks:

```sh
sudo iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j DROP
sudo iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -s 10.20.0.0/16 -j ACCEPT
```

Each `-I` inserts at the top of the chain, so the second rule runs first.
These rules do not survive a restart. The project has not tested them with this release.
Use `ufw` for SSH:

```sh
sudo ufw allow from 10.20.0.0/16 to any port 22 proto tcp
sudo ufw enable
```

### Decide on a load balancer or reverse proxy

You do not need a proxy. Staff can connect to the server directly.
Use a proxy when your district publishes every web service through one, or when the server has no public address.

**TCP passthrough is the recommended mode.**
The proxy forwards the encrypted connection to the server unchanged. The certificate stays on Campus Commander.
Examples: HAProxy `mode tcp`, NGINX `stream`, and an F5 or Citrix virtual server of the layer 4 type.

```text
frontend campus
    mode tcp
    bind :443
    default_backend campus_server

backend campus_server
    mode tcp
    server campus1 10.20.0.10:443 check
```

**A proxy that ends TLS must meet every rule below:**

- Send the original `Host` header. Campus Commander answers 421 "Use the configured application address." to any other host name.
- Connect to the server over HTTPS. Send the host name as the TLS server name, and verify the Campus Commander certificate.
- Do not buffer responses of `/api/events`. That path is a server-sent event stream.
- Allow at least 120 seconds of idle time on `/api/events`.
- Accept request bodies of at least 1 GiB. Device imports upload files up to that size.
- Pass every path, cookie, and the `Origin` header unchanged.

Campus Commander does not listen on port 80. Configure an HTTP to HTTPS redirect on the proxy if staff type `http://`.
Behind a proxy, Campus Commander records the proxy address as the client address.
When a proxy runs on another host, bind Campus Commander to the server address. Allow port 443 from the proxy only.

## Step 2. Prepare the server

Sign in to the server with your account. Run each command and compare the result.

1. Check the processor type, the cores, the memory, and the disk:

   ```sh
   uname -m
   nproc
   free -h
   df -h / /var/lib
   ```

   The processor type must be `x86_64`. Compare the other values with [What you need](#what-you-need).

2. Check the operating system and the clock:

   ```sh
   grep PRETTY_NAME /etc/os-release
   timedatectl
   ```

   `System clock synchronized` must read `yes`. If it reads `no`, run `sudo timedatectl set-ntp true` and check again after one minute.

3. Check the DNS name. The command must print the server address, or the address of your proxy:

   ```sh
   getent hosts campus.district.org
   ```

4. Update the system and install `curl`:

   ```sh
   sudo apt update
   sudo apt upgrade -y
   sudo apt install -y curl
   ```

5. Create the private installation directory:

   ```sh
   sudo install -d -m 700 /opt/campus-commander
   ```

## Step 3. Stage the certificate files

Copy the certificate files from your workstation to the server. Replace the names with yours:

```sh
scp campus.crt campus.key YOUR_USER@SERVER_ADDRESS:
```

On the server, move the files into a private staging directory:

```sh
sudo install -d -m 700 /root/cc-files
sudo install -m 600 ~/campus.crt /root/cc-files/edge-certificate.pem
sudo install -m 600 ~/campus.key /root/cc-files/edge-private-key.pem
rm ~/campus.crt ~/campus.key
```

For a district CA, also stage the CA certificate:

```sh
sudo install -m 600 ~/district-ca.crt /root/cc-files/edge-ca.pem
```

The installer copies each file into its private directory. Delete `/root/cc-files` after the installation.

## Step 4. Create the Google sign-in client and service account

Follow Steps 3, 4, and 5 of the [trial guide](try-campus-commander.md#step-3-create-a-google-cloud-project).
Make one change in Step 4: enter your address as the authorized redirect URI, for example:

```text
https://campus.district.org/api/auth/callback
```

Use exactly the address that you give the installer, with `/api/auth/callback` added. Include the port when your address has one.

Copy the downloaded client JSON file to the server, and stage it:

```sh
scp client_secret_*.json YOUR_USER@SERVER_ADDRESS:google-client.json
```

```sh
sudo install -m 600 ~/google-client.json /root/cc-files/google-client.json
rm ~/google-client.json
```

Keep the service account key file on your workstation. You upload it through the browser in Step 7.

## Step 5. Run the installer

Run the installer as root. Root can open port 443 for the port check, and it installs packages without a password prompt.

1. Open a root shell and download the installer:

   ```sh
   sudo -i
   cd /root
   curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh -o campus-commander-install.sh
   ```

2. Start the installation:

   ```sh
   sh campus-commander-install.sh --profile all-docker --qualification --root /opt/campus-commander
   ```

   `--qualification` selects candidate mode. Every current release requires it.

3. When a prerequisite is missing, select **Install automatically**. The installer explains each system change first.

4. Answer the questions. Press Enter to accept a default in brackets.

   | Question                                                            | Answer                                                              |
   | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
   | License                                                             | Read it and accept it                                               |
   | `Type candidate-lab to acknowledge ...`                             | `candidate-lab`                                                     |
   | `Installation project or namespace`                                 | A name that starts with `cc-`, for example `cc-campus`              |
   | `Generate a self-signed lab certificate (yes/no)`                   | `no`                                                                |
   | `Public HTTPS URL`                                                  | Your address, for example `https://campus.district.org`             |
   | `Public HTTPS certificate trust (system-ca/private-ca)`             | `system-ca` for a public CA, `private-ca` for a district CA         |
   | `HTTPS bind IPv4 address`                                           | The server address. Enter `0.0.0.0` to listen on every interface.   |
   | `Readiness connection IPv4 address`                                 | Press Enter                                                         |
   | `Lab prerequisite exceptions, comma-separated names, or none`       | `none`                                                              |
   | Database names, roles, capacities, and operators                    | Press Enter for each                                                |
   | `Application phase (1, 2, or 3)`                                    | Press Enter (`3`)                                                   |
   | `Sign-in provider (google/oidc)`                                    | `google`                                                            |
   | `Google client import (browser/file)`                               | `file`                                                              |
   | `Downloaded Google Web application JSON file`                       | `/root/cc-files/google-client.json`                                 |
   | Session lifetimes                                                   | Press Enter for each                                                |
   | `...edge.endpoint.tls.caSecretRef protected source FILE path`       | `/root/cc-files/edge-ca.pem`. Only `private-ca` asks this question. |
   | `...edge.serverTls.certificateSecretRef protected source FILE path` | `/root/cc-files/edge-certificate.pem`                               |
   | `...edge.serverTls.privateKeySecretRef protected source FILE path`  | `/root/cc-files/edge-private-key.pem`                               |

5. The installer checks the server, the DNS name, and the certificate. Then it starts the services.
   The first start downloads the images and takes several minutes. Success prints `ready` and your address.

## Step 6. Make yourself the first administrator

After `ready`, the installer prints an administrator setup address and a pairing code.
The address is your address with `/setup` added. The code expires after ten minutes.

1. On your workstation, open the browser profile of your school Google account.
2. Open the administrator setup address and enter the pairing code.
3. Sign in with your Google Workspace administrator account.
4. Return to the terminal. Check the account that the installer shows, and type `yes`.
5. The browser reports completion. Select **Sign in to Campus Commander**.

Then delete the staging directory and close the root shell:

```sh
rm -r /root/cc-files
exit
```

If a code expires, press Ctrl+C and resume the installation with the command in [Operate the installation](#operate-the-installation).

## Step 7. Connect your Google Workspace organization

Follow [Step 8 of the trial guide](try-campus-commander.md#step-8-connect-your-google-workspace-organization).
Then open **Diagnostics** and check each Google capability.

## Operate the installation

Run these commands as root on the server.

| Task                                            | Command                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Show the readiness of the services              | `sh /root/campus-commander-install.sh --root /opt/campus-commander --command status` |
| Resume after an interruption or an expired code | `sh /root/campus-commander-install.sh --root /opt/campus-commander --command resume` |
| Remove the services and keep the data           | `sh /root/campus-commander-install.sh --root /opt/campus-commander --uninstall`      |

Docker starts the services again after a server restart.
After each restart, run the status command. If a service is not ready, run the resume command.
The uninstall command asks for the project name, for example `cc-campus`. Type it to confirm.

The installer also has an update command. It requires a verified backup of the installation. This guide does not cover it.
Install each new review build on a fresh server instead.

Keep `/opt/campus-commander` private. It holds the credentials, the Google client secret, and the certificate key.
It also holds the Google connection key, `private/google-key-1`. Without that file, the stored service account key is unreadable.
Copy the directory to a protected location after the installation.
To end the installation and remove Google access, follow [Check, restart, and remove the installation](try-campus-commander.md#check-restart-and-remove-the-installation) in the trial guide.

## Troubleshooting

### The `https-port` check fails

- Run the installer as root for port 443. [Step 5](#step-5-run-the-installer) gives the commands.
- Another program uses the port. Find it with `sudo ss -ltnp 'sport = :443'`, and stop it.

### The `district-dns` check fails

The server cannot resolve the host name. Run `getent hosts campus.district.org` on the server.
Correct the DNS record or the DNS servers of the server, then resume the installation.

### The `edge-certificate` check fails

The certificate does not hold the host name, it is not valid now, or the key does not match.
Run the three commands of [Get the certificate](#get-the-certificate) and correct the files.

### The browser shows "Use the configured application address."

The browser or a proxy used another host name than your address.
Open exactly the address that you gave the installer. A proxy must send the original `Host` header.

### Google shows `Error 400: redirect_uri_mismatch`

The redirect URI of the sign-in client differs from your address.
Set it to exactly your address with `/api/auth/callback` added, as in [Step 4](#step-4-create-the-google-sign-in-client-and-service-account).

### Google checks fail behind a web filter

The web filter inspects TLS, or it requires a proxy. Exempt the server from both. Read [Plan the firewall](#plan-the-firewall).
