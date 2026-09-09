# Hosted Kubernetes installation test

This recipe prepares a disposable Kind fixture for the published hosted installer.
Preparation does not establish a successful installation.
Record success only after the published installer reports eight ready components.

Use the published entry for application installation and resume.
Do not render or edit application manifests from a source checkout.
Use the verified release only for credential preparation and answer validation.

## Prerequisites and limits

- Use a Linux amd64 host with Docker, Kind, kubectl, OpenSSL, Java keytool, curl, and CA certificates.
- Provide registry access to every signed application image and pinned upstream image.
- Stop if anonymous GHCR access returns HTTP 401. Do not substitute synthetic image references.
- Provide permission to mount one shared host directory into every Kind node.
- Reserve sufficient host memory and disk for three nodes, two PostgreSQL instances, and Kestra.
- Use a fresh fixture directory and namespace. Preserve existing installations and credentials.

The fixture uses one control-plane node and two worker nodes.
Worker anti-affinity requires two eligible worker nodes.
Add another worker when testing rescheduling without reducing available worker capacity.

The shared hostPath fixture tests storage across Kind nodes on one host.
It does not qualify production RWX storage or independent host failure recovery.
Stock Kind networking does not establish NetworkPolicy enforcement.
Prepare an enforcing CNI separately before claiming network-isolation evidence.

The edge uses a localhost port-forward because stock Kind has no usable LoadBalancer.
This tests TLS and hosted readiness, not production LoadBalancer behavior.
Setup has no Kubernetes NodePort, hostPort, connectAddress, or LoadBalancer annotation answers.

## Verify the published release

Replace the tag with the candidate under test.
Do not continue if any signature, image, or checksum verification fails.

```sh
set -eu
export CC_RELEASE_TAG=phase-1-candidate-REVISION12
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --release "$CC_RELEASE_TAG" --verify-only
```

Set `CC_VERIFIED_RELEASE` to the exact `Verified release:` directory printed by that command.
The command retains its downloaded tools beside the verified bundle.

```sh
export CC_VERIFIED_RELEASE=/absolute/private/cache/release.XXXXXXXX/bundle
export PATH="$(dirname "$CC_VERIFIED_RELEASE")/tools/node-v24.19.0-linux-x64/bin:$(dirname "$CC_VERIFIED_RELEASE")/tools:$PATH"
export CC_LAB=/tmp/cc-hosted-kube-fixture
export CC_CONTEXT=kind-cc-hosted-kube
export CC_NAMESPACE=cc-hosted-kube
export KUBECONFIG="$CC_LAB/kubeconfig"
umask 077
test ! -e "$CC_LAB"
mkdir -m 700 "$CC_LAB"
mkdir -m 700 "$CC_LAB/shared"
```

Run the remaining commands in the same shell.
Stop when a command fails.
Do not repeat directory or credential creation against an existing fixture.

## Prepare Kind and storage

Create the same shared mount on all nodes.

```sh
cat > "$CC_LAB/kind.yaml" <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: $CC_LAB/shared
        containerPath: /var/local/cc-hosted-shared
  - role: worker
    extraMounts:
      - hostPath: $CC_LAB/shared
        containerPath: /var/local/cc-hosted-shared
  - role: worker
    extraMounts:
      - hostPath: $CC_LAB/shared
        containerPath: /var/local/cc-hosted-shared
YAML
kind create cluster --name cc-hosted-kube --config "$CC_LAB/kind.yaml" --kubeconfig "$KUBECONFIG"
kubectl config use-context "$CC_CONTEXT"
kubectl --context "$CC_CONTEXT" get nodes
kubectl --context "$CC_CONTEXT" get storageclass standard
kubectl --context "$CC_CONTEXT" create namespace "$CC_NAMESPACE"
```

Prepare the shared directories for application UID/GID 1000.
These commands change only the new fixture directories.

```sh
mkdir -p "$CC_LAB/shared/campus-artifacts/artifacts" "$CC_LAB/shared/kestra-internal/kestra"
sudo chown -R 1000:1000 "$CC_LAB/shared/campus-artifacts" "$CC_LAB/shared/kestra-internal"
sudo chmod -R 700 "$CC_LAB/shared/campus-artifacts" "$CC_LAB/shared/kestra-internal"
cat > "$CC_LAB/storage.yaml" <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: cc-hosted-rwx
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: Immediate
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: cc-hosted-artifacts
spec:
  capacity:
    storage: 100Gi
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: cc-hosted-rwx
  claimRef:
    namespace: $CC_NAMESPACE
    name: campus-artifacts
  hostPath:
    path: /var/local/cc-hosted-shared/campus-artifacts
    type: Directory
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: cc-hosted-kestra
spec:
  capacity:
    storage: 100Gi
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: cc-hosted-rwx
  claimRef:
    namespace: $CC_NAMESPACE
    name: kestra-internal
  hostPath:
    path: /var/local/cc-hosted-shared/kestra-internal
    type: Directory
YAML
kubectl --context "$CC_CONTEXT" create -f "$CC_LAB/storage.yaml"
```

The installer creates the two RWX claims and two PostgreSQL RWO claims.
The `standard` class provisions PostgreSQL storage.
Redis uses ephemeral pod storage.

## Prepare credentials and exact answers

The following script creates credential files and prerequisite Secrets.
It reads reference names from the verified release example.
It does not create or modify application manifests.

All service credentials live in `campus-installation`.
The script creates separate `campus-migration`, `campus-database-admin`, and `campus-kestra-runtime` Secrets.
Source files contain exactly the corresponding Secret bytes.
The installer compares those bytes before Kubernetes installation.

Server certificates include each configured service DNS name.
Database certificates also include `localhost`.
The edge certificate includes `localhost` and uses the private CA.

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
process.on('uncaughtException', () => {
  process.stderr.write('Fixture preparation failed. Inspect protected files and prerequisite tool availability.\n');
  process.exit(1);
});
const { CC_LAB: lab, CC_VERIFIED_RELEASE: release, CC_NAMESPACE: namespace, CC_CONTEXT: context } = process.env;
if (!lab || !release || !namespace || !context) throw Error('Missing fixture environment');
const source = join(lab, 'secrets');
try { await access(source); throw Error('Preserve existing credentials'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(source, { mode: 0o700 });
const config = JSON.parse(await readFile(join(release, 'deployment/examples/kubernetes.json'), 'utf8'));
const operator = JSON.parse(await readFile(join(release, 'deployment/kubernetes/operator.example.json'), 'utf8'));
for (const [name, service] of Object.entries(config.services)) {
  service.endpoint.url = name === 'edge' ? 'https://localhost:18443' : service.endpoint.url.replaceAll('.campus-commander.svc.cluster.local', `.${namespace}.svc.cluster.local`);
}
config.services.edge.endpoint.tls = { mode: 'private-ca', caSecretRef: { provider: 'kubernetes', name: 'campus-installation', key: 'edge-ca' } };
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
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(source, 'ca.key'), '-out', join(source, 'ca.pem'), '-days', '7', '-subj', '/CN=Disposable hosted Kubernetes CA']);
const ca = await readFile(join(source, 'ca.pem'));
for (const [name, service] of Object.entries(config.services)) {
  if (service.endpoint.tls.caSecretRef) await put(service.endpoint.tls.caSecretRef, ca);
  if (service.passwordSecretRef) await put(service.passwordSecretRef, randomBytes(32).toString('hex'));
  if (service.bootstrapSecretRef) await put(service.bootstrapSecretRef, randomBytes(32).toString('base64url'));
  if (service.dispatchSecretRef) await put(service.dispatchSecretRef, randomBytes(32).toString('base64url'));
  if (service.authSecretRef) await put(service.authSecretRef, JSON.stringify({ username: 'qualification@example.invalid', password: `A1${randomBytes(32).toString('base64url')}` }));
  if (!service.serverTls) continue;
  const hostname = new URL(service.endpoint.url).hostname;
  const sans = [hostname, ...(name.endsWith('Database') ? ['localhost'] : [])];
  const key = join(source, `${name}.key`), csr = join(source, `${name}.csr`), cert = join(source, `${name}.pem`), extensions = join(source, `${name}.ext`);
  await writeFile(extensions, `subjectAltName=${sans.map((host) => `DNS:${host}`).join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`, { mode: 0o600, flag: 'wx' });
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${hostname}`]);
  run('openssl', ['x509', '-req', '-in', csr, '-CA', join(source, 'ca.pem'), '-CAkey', join(source, 'ca.key'), '-CAcreateserial', '-out', cert, '-days', '7', '-extfile', extensions]);
  await put(service.serverTls.certificateSecretRef, await readFile(cert));
  await put(service.serverTls.privateKeySecretRef, await readFile(key));
}
const serviceReferences = new Map(refs);
await put(operator.migrationPasswordSecretRef, randomBytes(32).toString('hex'));
for (const ref of Object.values(operator.databaseAdmins)) await put(ref, randomBytes(32).toString('hex'));
const kestra = config.services.kestra, database = config.services.kestraDatabase;
const runtime = join(source, 'kestra-runtime');
run(process.execPath, [join(release, 'deployment/kestra/render-config.mjs')], { env: {
  ...process.env,
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
  CC_KESTRA_TLS_CERTIFICATE_FILE: pathFor(kestra.serverTls.certificateSecretRef),
  CC_KESTRA_TLS_PRIVATE_KEY_FILE: pathFor(kestra.serverTls.privateKeySecretRef),
  CC_KESTRA_WORKER_BASE_URL: config.services.workers.endpoint.url,
  CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: pathFor(config.services.workers.dispatchSecretRef),
  CC_KESTRA_WORKER_CA_FILE: pathFor(config.services.workers.endpoint.tls.caSecretRef)
} });
const runtimeEnvironment = JSON.parse(await readFile(join(runtime, 'runtime-environment.json'), 'utf8'));
for (const [key, filename] of [['application-yaml', 'application.yaml'], ['server-p12', 'server.p12'], ['probe-header', 'probe-header'], ['worker-truststore-p12', 'worker-truststore.p12']]) {
  await put({ name: 'campus-kestra-runtime', key }, await readFile(join(runtime, filename)));
}
await put({ name: 'campus-kestra-runtime', key: 'java-options' }, runtimeEnvironment.JAVA_OPTS);
await put({ name: 'campus-kestra-runtime', key: 'dispatch-token' }, runtimeEnvironment.SECRET_CC_WORKER_DISPATCH_TOKEN);
const groups = new Map();
for (const [id, path] of refs) {
  const [name, key] = id.split('/');
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name).push(`--from-file=${key}=${path}`);
}
for (const [name, args] of groups) run('kubectl', ['--context', context, '-n', namespace, 'create', 'secret', 'generic', name, ...args]);
const answers = {
  profile: 'kubernetes', root: join(lab, 'install'), project: namespace,
  candidateAcknowledgement: 'candidate-lab', publicUrl: 'https://localhost:18443',
  edgeTrust: 'private-ca', exceptions: 'none', workerHosts: 2, apiReplicas: 2,
  'cluster.context': context, 'kubernetes.clusterDomain': 'cluster.local',
  'kubernetes.storageClasses.postgres': 'standard',
  'kubernetes.storageClasses.artifacts': 'cc-hosted-rwx',
  'kubernetes.storageClasses.kestraInternal': 'cc-hosted-rwx',
  'kubernetes.sourceRanges': '127.0.0.1/32', 'kubernetes.imagePullSecrets': 'none',
  migrationRole: 'campus-migrator'
};
for (const [name, service] of Object.entries(config.services)) {
  for (const key of ['persistence', 'internalStorage']) if (service[key]) answers[`services.${name}.${key}.location`] = service[key].location;
}
answers['artifacts.location'] = config.artifacts.location;
for (const [id, path] of serviceReferences) answers[`files.${id.replace('/', '.')}`] = path;
await writeFile(join(lab, 'answers.json'), JSON.stringify(answers, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(join(lab, 'resume-answers.json'), '{}\n', { mode: 0o600, flag: 'wx' });
process.stdout.write('Protected fixture credentials, prerequisite Secrets, and hosted answers are prepared.\n');
JS
```

The script generates all 24 required service-file answers.
It also generates the five storage-location answers without inventing additional configuration fields.
It retains default Secret names, database roles, capacities, and internal service endpoints.

## Validate answers without installation

This check reads protected answers and the verified release.
It calls only the question/configuration API and deployment schema validator.
It does not resolve credentials, render Kubernetes resources, or contact the cluster.

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const release = process.env.CC_VERIFIED_RELEASE;
const answers = JSON.parse(await readFile(join(process.env.CC_LAB, 'answers.json'), 'utf8'));
const { configure, createQuestions } = await import(pathToFileURL(join(release, 'deployment/installer/setup.mjs')));
const { parseDeploymentConfig } = await import(pathToFileURL(join(release, 'dist/deployment/lib/deployment.js')));
const q = createQuestions(answers);
const root = await q('root', 'Root');
const profile = await q('profile', 'Profile');
await q('candidateAcknowledgement', 'Candidate acknowledgement', undefined, (value) => value === 'candidate-lab');
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
const plan = await configure({ releaseRoot: release, root, profile, qualification: true, questions: q, manifest });
q.finish();
parseDeploymentConfig(plan.config);
if (plan.files.size !== 24) throw Error('Unexpected service credential inventory');
process.stdout.write('Hosted Kubernetes answers and deployment schema passed. No installation executed.\n');
JS
```

## Run the published installer

Run a port-forward supervisor in another terminal with the same fixture environment.
The first attempts fail until the installer creates the edge Service and pod.
The supervisor also restores forwarding after an edge pod replacement.

```sh
while :; do
  kubectl --context "$CC_CONTEXT" --namespace "$CC_NAMESPACE" \
    port-forward service/edge 18443:18443 --address localhost || true
  sleep 2
done
```

The Service exposes port 18443 and forwards to the container listener on port 8443.
The localhost listener supports IPv4 and IPv6 localhost resolution.
No district-DNS exception is required.

Invoke the actual published entry:

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --release "$CC_RELEASE_TAG" --qualification \
    --profile kubernetes --root "$CC_LAB/install" \
    --answers "$CC_LAB/answers.json" --accept-license --no-install-dependencies
```

Cold image pulls can exceed the initial readiness window.
Preserve the installation and inspect pod readiness before resuming.
Do not edit generated application manifests to obtain readiness.

```sh
kubectl --context "$CC_CONTEXT" -n "$CC_NAMESPACE" get pods,pvc,services
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --profile kubernetes --root "$CC_LAB/install" --command resume \
    --answers "$CC_LAB/resume-answers.json" --accept-license --no-install-dependencies
```

Capture release identity, installer status, component readiness, PVC bindings, and pod placement as evidence.
Record the shared-host storage, port-forward routing, and networking limits with that evidence.
Do not capture Secret objects, credential values, or private runtime files.
Stop the port-forward supervisor after the test.
Preserve the evidence, then remove only the named fixture resources.
