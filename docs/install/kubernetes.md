# Install Campus Commander on Kubernetes

This guide installs Campus Commander on an existing Kubernetes cluster.
The installer runs every component in one namespace.
The components are the HTTPS edge, the web client, the API, the job workers, Kestra, PostgreSQL, and Redis.
It assumes Google Workspace super administrator access, cluster administrator access, and Linux command-line experience.

## Contents

- [Choose a layout](#choose-a-layout)
- [Read this first](#read-this-first)
- [What you need](#what-you-need)
- [Step 1. Plan the address, DNS, certificate, network policy, and proxy](#step-1-plan-the-address-dns-certificate-network-policy-and-proxy)
- [Step 2. Check the cluster](#step-2-check-the-cluster)
- [Step 3. Create the Google sign-in client and service account](#step-3-create-the-google-sign-in-client-and-service-account)
- [Step 4. Verify the release and prepare the shell](#step-4-verify-the-release-and-prepare-the-shell)
- [Step 5. Create the namespace, Secrets, and answers](#step-5-create-the-namespace-secrets-and-answers)
- [Step 6. Run the installer](#step-6-run-the-installer)
- [Step 7. Point the DNS name at the load balancer](#step-7-point-the-dns-name-at-the-load-balancer)
- [Step 8. Make yourself the first administrator](#step-8-make-yourself-the-first-administrator)
- [Step 9. Connect your Google Workspace organization](#step-9-connect-your-google-workspace-organization)
- [Operate the installation](#operate-the-installation)
- [Troubleshooting](#troubleshooting)

## Choose a layout

| Layout                       | Guide                                                       | Use it when                                                                                        |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Trial                        | [Try Campus Commander](try-campus-commander.md)             | You want a disposable evaluation at `https://localhost:8443`                                       |
| One server                   | [Install on one server](single-server.md)                   | You want one machine to operate. This layout fits a single school and most districts.              |
| One server and your services | [Install with your existing services](existing-services.md) | Your district operates PostgreSQL, Redis, and NFS storage, and wants job workers on separate hosts |
| Kubernetes                   | This guide                                                  | Your district operates a Kubernetes cluster with shared storage and network policy enforcement     |

Kubernetes is the only layout that runs more than one API process and spreads the workers across nodes.
A node failure then stops part of the service, not all of it. PostgreSQL, Redis, and Kestra still run one copy each.
The project has not measured capacity for a number of users or devices.

## Read this first

**Every release is a review build.**
The project publishes review builds only. No accepted production release exists yet.

The installer installs a signed review build in candidate mode.
Candidate mode requires a namespace that starts with `cc-`.
Treat the data in a review build as disposable. Install each new review build in a fresh namespace.

**Test status of this layout.**
This layout last passed a hosted installation test on 2026-09-09, with an early review build on a three-node test cluster.
That test used shared host storage and a port forward, and its network plugin did not enforce network policy.
The current review builds pass only the one-server tests. Expect to report defects in this layout.

**Known issues in release `phase-3-lab-87410bf7d21b`:**

1. The release has no procedure to replace a certificate of an installation.
   Use certificates that stay valid for the whole review period.
2. Guided setup has no question for load balancer annotations.
   A cloud load balancer that needs an annotation to stay internal gets the default type of your cluster.
3. The release has no procedure to change the Google address ranges of the network policy after the installation.

**Some actions change Google Workspace.**
Device commands, custom attribute categories, and custom attribute values write to your organization.
The trial guide lists each action in [Read this first](try-campus-commander.md#read-this-first).

## What you need

| Item                 | Requirement                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Kubernetes           | Version 1.35.8 or later within version 1                                                                        |
| Nodes                | Linux amd64 nodes. One node for each worker replica, at least two, plus one spare node for a worker reschedule. |
| Network plugin       | A plugin that enforces ingress and egress NetworkPolicy, such as Calico or Cilium                               |
| Load balancer        | A layer 4 `LoadBalancer` Service implementation, such as MetalLB or the load balancer of your cloud             |
| Block storage        | A ReadWriteOnce storage class for the two PostgreSQL databases                                                  |
| Shared storage       | A ReadWriteMany storage class that keeps data across pod reschedules and supports files owned by user ID 1000   |
| Registry access      | Every node can pull from `ghcr.io` and `docker.io`                                                              |
| Cluster access       | A kubectl context that can create a namespace, Secrets, and the installed resources                             |
| Operator workstation | Ubuntu 24.04 LTS, amd64, with kubectl, OpenSSL, and Java `keytool`                                              |
| Host name            | One DNS name for Campus Commander, for example `campus.district.org`                                            |
| Certificate          | A TLS certificate and its private key for that host name                                                        |
| Google               | A super administrator account, and permission to create a Google Cloud project in your organization             |

With two API replicas and two worker replicas, the pods request 1.7 CPU cores in total. They request 2.9 GiB of memory.
Kestra requests the largest share: 0.5 cores and 1 GiB.

Install the workstation tools:

```sh
sudo apt update
sudo apt install -y curl openssl openjdk-21-jre-headless
kubectl version --client
```

Install kubectl through your usual procedure when the last command fails.

## Step 1. Plan the address, DNS, certificate, network policy, and proxy

### Choose intranet access or internet access

| Decision        | Intranet access                                       | Internet access                                             |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Who connects    | Staff on district networks and on the district VPN    | Staff on any network                                        |
| Load balancer   | An address on a district network                      | A public address, or a private address behind your firewall |
| DNS record      | Internal DNS only                                     | Public DNS, and internal DNS for staff inside the district  |
| Certificate     | A public CA certificate, or a district CA certificate | A public CA certificate                                     |
| Allowed sources | Your staff networks                                   | `0.0.0.0/0`, or the address ranges that you allow           |

The installer creates one `LoadBalancer` Service named `edge`. It is the only entry point.
The Service sets `externalTrafficPolicy: Local`, so the edge sees the real client address.
The installer applies the allowed sources twice: in `loadBalancerSourceRanges`, and in the ingress network policy of the edge.
Include the address of your operator workstation. The installer checks readiness through the load balancer.

On premises, MetalLB assigns an address from its default pool. That address is internal when the pool is internal.
In a cloud, the default `LoadBalancer` type is often public. Known issue 2 applies: restrict it with the allowed sources.

Google sign-in works for both choices. Google sends the browser back to Campus Commander and never connects to your cluster.

### Choose the host name

- Use one DNS name under a domain that your district owns, with a public top-level domain such as `.org`. Google rejects `.local` names and IP addresses in sign-in return addresses.
- The application address is `https://` and the host name, with no path. The Service listens on port 443, or on the port of your address.

### Plan the DNS record

Create an A record for the host name that points at the address of the `edge` Service.
The installer checks that the name resolves before it creates any resource.
The Service address exists only after the installation starts.
When your load balancer cannot reserve the address in advance, create the record with a temporary address. [Step 7](#step-7-point-the-dns-name-at-the-load-balancer) corrects it.
For internet access, also create the public record, and an internal record for staff inside the district.

### Get the certificate

The public certificate follows the rules of the one-server guide: [Get the certificate](single-server.md#get-the-certificate).
The preparation script of Step 5 creates an internal CA for the connections inside the namespace. You need no other certificate.

### Plan the network policy and the firewall

The installer creates a NetworkPolicy for every component. Each policy allows only the paths that the component needs.
Kubernetes DNS is allowed on UDP and TCP port 53 to the pods with label `k8s-app: kube-dns` in `kube-system`.
Check that your cluster DNS has that label:

```sh
kubectl --context YOUR_CONTEXT -n kube-system get pods -l k8s-app=kube-dns
```

When your DNS pods use another namespace or label, add `kubernetes.dns.namespace` and `kubernetes.dns.podLabels.k8s-app` to the answers file of Step 5.
NodeLocal DNSCache needs its own policy work and is not covered.

The API pods reach Google sign-in through an egress policy to address ranges that you supply.
The API and worker pods reach the Google APIs through a second egress policy with the same ranges.
Google publishes its ranges in `goog.json`. Step 4 turns that file into the answer.
Google changes the list. Known issue 3 applies.

Outside the cluster, allow these paths:

| From                            | To                        | Port    | Use                                      |
| ------------------------------- | ------------------------- | ------- | ---------------------------------------- |
| Staff networks, or the internet | The load balancer address | TCP 443 | Campus Commander                         |
| The nodes                       | Google                    | TCP 443 | Sign-in, Google Workspace data, and jobs |
| The nodes                       | `ghcr.io` and Docker Hub  | TCP 443 | Images                                   |
| The operator workstation        | GitHub                    | TCP 443 | Installer and release files              |
| The operator workstation        | The load balancer address | TCP 443 | Readiness check                          |

The outbound host names for Google, GitHub, and Docker Hub are in the one-server guide: [Plan the firewall](single-server.md#plan-the-firewall).
That guide also explains why this release needs direct outbound HTTPS to Google without a proxy and without TLS inspection.

### Decide on a proxy or an ingress controller

The installer does not use an HTTP Ingress controller. The `edge` Service carries the TLS connection to the edge pod.
To publish Campus Commander through an existing proxy, use TCP passthrough to the load balancer address.
Add the proxy address to the allowed sources. The edge then sees the proxy address as the client address.
A proxy that ends TLS must meet the one-server rules: [Decide on a load balancer or reverse proxy](single-server.md#decide-on-a-load-balancer-or-reverse-proxy).

## Step 2. Check the cluster

Run these checks with your context. Replace `YOUR_CONTEXT`.

```sh
kubectl --context YOUR_CONTEXT version
kubectl --context YOUR_CONTEXT get nodes -o wide
kubectl --context YOUR_CONTEXT get storageclass
```

- The server version must be 1.35.8 or later within version 1.
- At least three nodes must accept workloads, with architecture `amd64`.
- Write down the name of a ReadWriteOnce class and of a ReadWriteMany class.

The ReadWriteMany class must allow writes from user ID 1000 and support ownership changes on the volume.
For example, the NFS CSI driver, CephFS, Azure Files, and Amazon EFS provide ReadWriteMany volumes. Check the ownership support of your driver.
Pods start with private directories owned by user ID 1000 inside each shared volume.

## Step 3. Create the Google sign-in client and service account

Follow Steps 3, 4, and 5 of the [trial guide](try-campus-commander.md#step-3-create-a-google-cloud-project).
In Step 4, enter your address with `/api/auth/callback` added as the redirect URI, for example `https://campus.district.org/api/auth/callback`.

Keep the downloaded client JSON file on the operator workstation. The script of Step 5 copies it into a private file.
Keep the service account key file on your workstation. You upload it through the browser in Step 9.

## Step 4. Verify the release and prepare the shell

Run the remaining steps in one shell on the operator workstation. Stop when a command fails.

1. Download the installer and verify the release without installing:

   ```sh
   cd ~
   curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh -o campus-commander-install.sh
   export CC_RELEASE_TAG=phase-3-lab-87410bf7d21b
   sh campus-commander-install.sh --release "$CC_RELEASE_TAG" --verify-only
   ```

   The last line reads `Verified release:` and a directory.

2. Set the variables. Replace each value with yours:

   ```sh
   export CC_VERIFIED_RELEASE=/PRINTED/release.XXXXXXXX/bundle
   export CC_WORK="$HOME/cc-campus"
   export CC_CONTEXT=YOUR_CONTEXT
   export CC_NAMESPACE=cc-campus
   export CC_PUBLIC_HOST=campus.district.org
   export CC_EDGE_CERTIFICATE=/path/to/campus.crt
   export CC_EDGE_PRIVATE_KEY=/path/to/campus.key
   export CC_GOOGLE_CLIENT=/path/to/client_secret.json
   export CC_STORAGE_RWO=YOUR_RWO_CLASS
   export CC_STORAGE_RWX=YOUR_RWX_CLASS
   export CC_SOURCE_RANGES=10.20.0.0/16,10.30.0.0/16
   T="$(dirname "$CC_VERIFIED_RELEASE")/tools"
   export PATH="$T/node-v24.19.0-linux-x64/bin:$T:$PATH"
   node --version
   ```

   For a district CA, also set `export CC_EDGE_CA=/path/to/district-ca.crt`.
   For more replicas, set `CC_API_REPLICAS` and `CC_WORKER_REPLICAS`. Each defaults to 2.
   The worker replicas must not exceed the nodes that accept workloads.
   For a cluster domain other than `cluster.local`, set `CC_CLUSTER_DOMAIN`.

3. Build the Google address ranges for the sign-in and Google API egress policies:

   ```sh
   export CC_GOOGLE_CIDRS=$(curl -fsSL https://www.gstatic.com/ipranges/goog.json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).prefixes.map((p)=>p.ipv4Prefix).filter(Boolean).join(",")))')
   echo "$CC_GOOGLE_CIDRS" | tr ',' '\n' | wc -l
   ```

   The count is the number of Google IPv4 ranges. A dual-stack cluster also needs the `ipv6Prefix` values.

## Step 5. Create the namespace, Secrets, and answers

1. Create the work directory and the namespace:

   ```sh
   umask 077
   mkdir -m 700 "$CC_WORK"
   kubectl --context "$CC_CONTEXT" create namespace "$CC_NAMESPACE"
   ```

2. Save the preparation script. It creates the internal CA and certificates, the passwords, the Kestra runtime files, five Secrets, and the installer answers:

   ```sh
   cat > "$CC_WORK/prepare.mjs" <<'JS'
   // Prepare the Campus Commander Kubernetes credentials, Secrets, and installer answers.
   // Adapted from deployment/installer/HOSTED-KUBERNETES-TEST.md for a district cluster.
   import { execFileSync } from 'node:child_process';
   import { randomBytes } from 'node:crypto';
   import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
   import { join } from 'node:path';

   process.on('uncaughtException', (error) => {
     process.stderr.write(`Preparation failed: ${error.message}\n`);
     process.exit(1);
   });
   const env = process.env;
   const need = (name) => {
     if (!env[name]) throw Error(`Set ${name}.`);
     return env[name];
   };
   const release = need('CC_VERIFIED_RELEASE');
   const work = need('CC_WORK');
   const context = need('CC_CONTEXT');
   const namespace = need('CC_NAMESPACE');
   const host = need('CC_PUBLIC_HOST');
   const clusterDomain = env.CC_CLUSTER_DOMAIN ?? 'cluster.local';
   const edgeCa = env.CC_EDGE_CA;
   const source = join(work, 'secrets');
   try {
     await access(source);
     throw Error('Preserve the existing credentials in CC_WORK/secrets.');
   } catch (error) {
     if (error.code !== 'ENOENT') throw error;
   }
   await mkdir(source, { mode: 0o700 });
   const config = JSON.parse(
     await readFile(join(release, 'deployment/examples/kubernetes.json'), 'utf8'),
   );
   const operator = JSON.parse(
     await readFile(
       join(release, 'deployment/kubernetes/operator.example.json'),
       'utf8',
     ),
   );
   for (const [name, service] of Object.entries(config.services))
     if (name !== 'edge')
       service.endpoint.url = service.endpoint.url.replaceAll(
         '.campus-commander.svc.cluster.local',
         `.${namespace}.svc.${clusterDomain}`,
       );
   const refs = new Map();
   const put = async (ref, bytes) => {
     const id = `${ref.name}/${ref.key}`;
     if (refs.has(id)) return refs.get(id);
     const directory = join(source, ref.name);
     await mkdir(directory, { recursive: true, mode: 0o700 });
     const path = join(directory, ref.key);
     await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
     refs.set(id, path);
     return path;
   };
   const pathFor = (ref) => refs.get(`${ref.name}/${ref.key}`);
   const run = (file, args, options = {}) =>
     execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
   run('openssl', [
     'req',
     '-x509',
     '-newkey',
     'rsa:3072',
     '-nodes',
     '-keyout',
     join(source, 'ca.key'),
     '-out',
     join(source, 'ca.pem'),
     '-days',
     '3650',
     '-subj',
     '/CN=Campus Commander internal CA',
   ]);
   const ca = await readFile(join(source, 'ca.pem'));
   for (const [name, service] of Object.entries(config.services)) {
     if (service.endpoint.tls.caSecretRef)
       await put(service.endpoint.tls.caSecretRef, ca);
     if (service.passwordSecretRef)
       await put(service.passwordSecretRef, randomBytes(32).toString('hex'));
     if (service.bootstrapSecretRef)
       await put(
         service.bootstrapSecretRef,
         randomBytes(32).toString('base64url'),
       );
     if (service.dispatchSecretRef)
       await put(service.dispatchSecretRef, randomBytes(32).toString('base64url'));
     if (service.authSecretRef)
       await put(
         service.authSecretRef,
         JSON.stringify({
           username: `kestra@${host}`,
           password: `A1${randomBytes(32).toString('base64url')}`,
         }),
       );
     if (!service.serverTls) continue;
     if (name === 'edge') {
       await put(
         service.serverTls.certificateSecretRef,
         await readFile(need('CC_EDGE_CERTIFICATE')),
       );
       await put(
         service.serverTls.privateKeySecretRef,
         await readFile(need('CC_EDGE_PRIVATE_KEY')),
       );
       continue;
     }
     const hostname = new URL(service.endpoint.url).hostname;
     const sans = [hostname, ...(name.endsWith('Database') ? ['localhost'] : [])];
     const key = join(source, `${name}.key`);
     const csr = join(source, `${name}.csr`);
     const cert = join(source, `${name}.pem`);
     const extensions = join(source, `${name}.ext`);
     await writeFile(
       extensions,
       `subjectAltName=${sans.map((value) => `DNS:${value}`).join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
       { mode: 0o600, flag: 'wx' },
     );
     run('openssl', [
       'req',
       '-new',
       '-newkey',
       'rsa:3072',
       '-nodes',
       '-keyout',
       key,
       '-out',
       csr,
       '-subj',
       `/CN=${hostname}`,
     ]);
     run('openssl', [
       'x509',
       '-req',
       '-in',
       csr,
       '-CA',
       join(source, 'ca.pem'),
       '-CAkey',
       join(source, 'ca.key'),
       '-CAcreateserial',
       '-out',
       cert,
       '-days',
       '825',
       '-extfile',
       extensions,
     ]);
     await put(service.serverTls.certificateSecretRef, await readFile(cert));
     await put(service.serverTls.privateKeySecretRef, await readFile(key));
   }
   if (edgeCa)
     await put(
       { name: 'campus-installation', key: 'edge-ca' },
       await readFile(edgeCa),
     );
   await put(
     { name: 'campus-installation', key: 'google-key-1' },
     randomBytes(32),
   );
   const serviceReferences = new Map(refs);
   await put(operator.migrationPasswordSecretRef, randomBytes(32).toString('hex'));
   for (const ref of Object.values(operator.databaseAdmins))
     await put(ref, randomBytes(32).toString('hex'));
   const googleClient = join(work, 'google-client.json');
   await writeFile(googleClient, await readFile(need('CC_GOOGLE_CLIENT')), {
     mode: 0o600,
     flag: 'wx',
   });
   const client = JSON.parse(await readFile(googleClient, 'utf8')).web;
   await put({ name: 'campus-oidc', key: 'client-secret' }, client.client_secret);
   const kestra = config.services.kestra;
   const database = config.services.kestraDatabase;
   const runtime = join(source, 'kestra-runtime');
   run(process.execPath, [join(release, 'deployment/kestra/render-config.mjs')], {
     env: {
       ...env,
       CC_KESTRA_PROFILE: 'kubernetes',
       CC_KESTRA_RUNTIME_DIR: runtime,
       CC_KESTRA_RUNTIME_MOUNT_PATH: '/run/kestra-runtime',
       CC_KESTRA_AUTH_FILE: pathFor(kestra.authSecretRef),
       CC_KESTRA_DATABASE_PASSWORD_FILE: pathFor(database.passwordSecretRef),
       CC_KESTRA_DATABASE_URL: `jdbc:${database.endpoint.url}/${database.database}?sslmode=verify-full&sslrootcert=/run/secrets/campus-installation/district-ca`,
       CC_KESTRA_DATABASE_USERNAME: database.role,
       CC_KESTRA_URL: kestra.endpoint.url,
       CC_KESTRA_STORAGE_PATH: kestra.internalStorage.location,
       CC_KESTRA_TLS_ENABLED: 'true',
       CC_KESTRA_TLS_CERTIFICATE_FILE: pathFor(
         kestra.serverTls.certificateSecretRef,
       ),
       CC_KESTRA_TLS_PRIVATE_KEY_FILE: pathFor(
         kestra.serverTls.privateKeySecretRef,
       ),
       CC_KESTRA_WORKER_BASE_URL: config.services.workers.endpoint.url,
       CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: pathFor(
         config.services.workers.dispatchSecretRef,
       ),
       CC_KESTRA_WORKER_CA_FILE: pathFor(
         config.services.workers.endpoint.tls.caSecretRef,
       ),
     },
   });
   const runtimeEnvironment = JSON.parse(
     await readFile(join(runtime, 'runtime-environment.json'), 'utf8'),
   );
   for (const [key, filename] of [
     ['application-yaml', 'application.yaml'],
     ['server-p12', 'server.p12'],
     ['probe-header', 'probe-header'],
     ['worker-truststore-p12', 'worker-truststore.p12'],
   ])
     await put(
       { name: 'campus-kestra-runtime', key },
       await readFile(join(runtime, filename)),
     );
   await put(
     { name: 'campus-kestra-runtime', key: 'java-options' },
     runtimeEnvironment.JAVA_OPTS,
   );
   await put(
     { name: 'campus-kestra-runtime', key: 'dispatch-token' },
     runtimeEnvironment.SECRET_CC_WORKER_DISPATCH_TOKEN,
   );
   const groups = new Map();
   for (const [id, path] of refs) {
     const [name, key] = id.split('/');
     if (!groups.has(name)) groups.set(name, []);
     groups.get(name).push(`--from-file=${key}=${path}`);
   }
   for (const [name, args] of groups)
     run('kubectl', [
       '--context',
       context,
       '-n',
       namespace,
       'create',
       'secret',
       'generic',
       name,
       ...args,
     ]);
   const answers = {
     profile: 'kubernetes',
     root: join(work, 'install'),
     project: namespace,
     candidateAcknowledgement: 'candidate-lab',
     publicUrl: `https://${host}`,
     edgeTrust: edgeCa ? 'private-ca' : 'system-ca',
     exceptions: 'none',
     workerHosts: Number(env.CC_WORKER_REPLICAS ?? 2),
     apiReplicas: Number(env.CC_API_REPLICAS ?? 2),
     'cluster.context': context,
     'kubernetes.clusterDomain': clusterDomain,
     'kubernetes.storageClasses.postgres': need('CC_STORAGE_RWO'),
     'kubernetes.storageClasses.artifacts': need('CC_STORAGE_RWX'),
     'kubernetes.storageClasses.kestraInternal': need('CC_STORAGE_RWX'),
     'kubernetes.sourceRanges': need('CC_SOURCE_RANGES'),
     'kubernetes.imagePullSecrets': 'none',
     migrationRole: 'campus-migrator',
     'applicationAuth.provider': 'google',
     'applicationAuth.googleImport': 'file',
     'applicationAuth.googleClientFile': googleClient,
     'kubernetes.externalEgress.identityProvider': need('CC_GOOGLE_CIDRS'),
     'kubernetes.externalEgress.googleProvider': need('CC_GOOGLE_CIDRS'),
   };
   for (const [name, service] of Object.entries(config.services))
     for (const key of ['persistence', 'internalStorage'])
       if (service[key])
         answers[`services.${name}.${key}.location`] = service[key].location;
   answers['artifacts.location'] = config.artifacts.location;
   for (const [id, path] of serviceReferences)
     answers[`files.${id.replace('/', '.')}`] = path;
   await writeFile(
     join(work, 'answers.json'),
     JSON.stringify(answers, null, 2) + '\n',
     {
       mode: 0o600,
       flag: 'wx',
     },
   );
   await writeFile(join(work, 'resume-answers.json'), '{}\n', {
     mode: 0o600,
     flag: 'wx',
   });
   process.stdout.write(
     `Created ${groups.size} Secrets and the installer answers in ${work}.\n`,
   );
   JS
   ```

3. Run it:

   ```sh
   node "$CC_WORK/prepare.mjs"
   ```

   It prints `Created 5 Secrets and the installer answers`.
   It creates `campus-installation`, `campus-migration`, `campus-database-admin`, `campus-oidc`, and `campus-kestra-runtime` in the namespace.

Keep `$CC_WORK` private and keep it after the installation.
The installer compares each Secret with its file in `$CC_WORK/secrets` at every resume.
The directory also holds the key of the internal CA.
The `google-key-1` entry of `campus-installation` is the Google connection key. Without it, the stored service account key is unreadable.

## Step 6. Run the installer

Run the installer with the answers file:

```sh
sh campus-commander-install.sh --release "$CC_RELEASE_TAG" --qualification \
  --profile kubernetes --root "$CC_WORK/install" \
  --answers "$CC_WORK/answers.json" --accept-license --no-install-dependencies
```

`--accept-license` records your acceptance of the license. Read it in the release first.
`--no-install-dependencies` prints instructions instead of changing the workstation when a tool is missing.

The installer verifies the release, checks the cluster and the Secrets, and applies the resources.
It then waits for readiness through your address. With a temporary DNS address, that wait fails. Continue with Step 7.

Cold image pulls can also exceed the first wait. Do not edit the installed resources. Resume instead.

## Step 7. Point the DNS name at the load balancer

1. Read the address of the `edge` Service:

   ```sh
   kubectl --context "$CC_CONTEXT" -n "$CC_NAMESPACE" get service edge -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}{"\n"}'
   ```

2. Set the DNS record to that address, and wait until the workstation resolves it:

   ```sh
   getent hosts "$CC_PUBLIC_HOST"
   ```

3. Check the pods, then resume the installation:

   ```sh
   kubectl --context "$CC_CONTEXT" -n "$CC_NAMESPACE" get pods,pvc,services
   sh campus-commander-install.sh --profile kubernetes --root "$CC_WORK/install" --command resume \
     --answers "$CC_WORK/resume-answers.json" --accept-license --no-install-dependencies
   ```

   Success prints `Readiness: ready` and your address.

## Step 8. Make yourself the first administrator

Administrator enrollment needs an interactive terminal. Resume once without the answers file:

```sh
sh campus-commander-install.sh --root "$CC_WORK/install" --command resume
```

The installer prints an administrator setup address and a pairing code. The code expires after ten minutes.

1. Open the browser profile of your school Google account.
2. Open the administrator setup address and enter the pairing code.
3. Sign in with your Google Workspace administrator account.
4. Return to the terminal. Check the account that the installer shows, and type `yes`.
5. The browser reports completion. Select **Sign in to Campus Commander**.

## Step 9. Connect your Google Workspace organization

Follow [Step 8 of the trial guide](try-campus-commander.md#step-8-connect-your-google-workspace-organization).
Then open **Diagnostics** and check each Google capability.

## Operate the installation

Run these commands on the operator workstation with the variables of Step 4.

| Task                                        | Command                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| Show the readiness of the services          | `sh campus-commander-install.sh --root "$CC_WORK/install" --command status` |
| Resume after an interruption                | `sh campus-commander-install.sh --root "$CC_WORK/install" --command resume` |
| Remove the workloads and keep the data      | `sh campus-commander-install.sh --root "$CC_WORK/install" --uninstall`      |
| Read the pods, the claims, and the Services | `kubectl --context "$CC_CONTEXT" -n "$CC_NAMESPACE" get pods,pvc,services`  |

The uninstall command asks for the namespace name. Type it to confirm.
It keeps the namespace, the persistent volume claims, and the Secrets.
To end the installation, delete the namespace, then remove Google access as in [Check, restart, and remove the installation](try-campus-commander.md#check-restart-and-remove-the-installation).
Check the reclaim policy of your storage classes. A `Retain` policy keeps the volumes after the namespace is gone.

The installer also has an update command. It requires a verified backup. This guide does not cover it.
Install each new review build in a fresh namespace instead.

## Troubleshooting

### The preparation script stops

- `Preserve the existing credentials in CC_WORK/secrets.` The script runs once for each work directory. Use a new `CC_WORK` and a new namespace to start again.
- `Set CC_...` A variable of Step 4 is missing.
- A `kubectl` error: the context cannot create Secrets in the namespace, or a Secret exists. Delete the namespace and start again with a new `CC_WORK`.

### The installer reports a Secret mismatch

The installer found a Secret whose value differs from its file in `$CC_WORK/secrets`. Somebody changed the Secret or the file.
Restore the original value, or start again in a new namespace.

### Pods stay in `Pending`

- Worker pods: each worker replica needs its own node. Add a node or lower `CC_WORKER_REPLICAS`.
- Claims stay `Pending`: the storage class name is wrong, or it cannot provide the access mode. Run `kubectl get pvc` in the namespace.

### The readiness check fails after the DNS change

- The workstation address must be in `CC_SOURCE_RANGES`.
- The load balancer must forward TCP 443 to the nodes that run the edge pod.
- Run `getent hosts "$CC_PUBLIC_HOST"` on the workstation. It must print the Service address.

### Google sign-in fails with a network error

The egress policy of the API allows only the ranges in `CC_GOOGLE_CIDRS`. Google added a range since the installation. Known issue 3 applies.

### Other problems

The one-server guide covers the `district-dns` and `edge-certificate` checks, the 421 answer, and the sign-in errors: [Troubleshooting](single-server.md#troubleshooting).
