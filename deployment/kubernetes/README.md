# Kubernetes profile

The renderer creates a deterministic Kubernetes JSON List from validated deployment configuration and explicit operator inputs.
It creates only locally managed services. External dependencies remain under district ownership.
The frontend, API, and worker image references must exactly match the shared release inventory.
The renderer does not resolve credentials, create Secrets, or connect to a cluster.

## Prerequisites

- A district Kubernetes cluster with Linux amd64 worker nodes.
- At least two API replicas and two worker replicas in the deployment configuration.
- One eligible node per worker replica for required worker anti-affinity.
- One additional eligible node for a worker reschedule while the other workers remain operational.
- A CNI that enforces ingress and egress NetworkPolicy.
- A district Layer 4 LoadBalancer that forwards encrypted TCP traffic to the HTTPS edge.
- Explicit approved client CIDRs for the edge and endpoint CIDRs for external dependencies.
- A ReadWriteOnce storage class for each locally managed PostgreSQL database.
- A qualified ReadWriteMany storage class for artifacts and separate Kestra internal storage.
- Consistent UID 1000 across artifact consumers, supported filesystem ownership, and directory sync.
- Registry access to every pinned application and upstream image.
- Prepared Kubernetes Secrets with listener certificates, trust roots, and service-specific credentials.

The renderer uses namespace-scoped service names from the deployment contract.
For example, the API endpoint uses `api.<namespace>.svc.<clusterDomain>`.
Listener certificates must include the configured hostname in their SAN extension.
The public edge certificate must match the configured district hostname.
Local application listeners require explicit unprivileged ports.
The qualified Kestra HTTPS listener uses port 8080.

## Operator inputs

[operator.example.json](operator.example.json) illustrates the input shape with synthetic images and infrastructure names.
It does not identify a published release or an existing district storage class.
Replace its `release` object with the verified shared release inventory.
Set the same image references in the deployment configuration.
Set API replicas to at least two. The base CC-4 example contains one API replica and deliberately fails this prerequisite.

| Input                                         | Responsibility                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `namespace`, `clusterDomain`                  | Match configured service hostnames and certificate SANs.                                                     |
| `workerNodeCount`                             | Declare eligible nodes. The renderer requires at least the worker replica count.                             |
| `storageClasses.postgres`                     | Provide durable RWO storage for locally managed databases.                                                   |
| `storageClasses.artifacts`                    | Provide qualified RWX artifact storage.                                                                      |
| `storageClasses.kestraInternal`               | Provide separate qualified RWX Kestra storage when Kestra runs locally.                                      |
| `release`                                     | Supply source revision, architecture, and identical application image references.                            |
| `imagePullSecrets`                            | Optionally reference separately prepared registry credentials.                                               |
| `migrationRole`, `migrationPasswordSecretRef` | Supply the dedicated non-superuser application migrator.                                                     |
| `databaseAdmins`                              | Supply separate installation credentials only for locally managed databases.                                 |
| `kestraRuntime`                               | Reference operator-generated Kestra configuration, keystore, probe header, truststore, and environment keys. |
| `edgeIngress`                                 | Declare approved source CIDRs and district LoadBalancer annotations.                                         |
| `externalEgress`                              | Map each external dependency to approved endpoint CIDRs.                                                     |
| `dns`                                         | Identify the cluster DNS namespace and pod labels.                                                           |

NodeLocal DNS and controller-specific networking require separate policy qualification.
The supplied DNS policy selects ordinary cluster DNS pods on UDP and TCP port 53.
Filesystem mount traffic and CSI control traffic require district node-network configuration outside these pod policies.

## Secrets and Kestra

Generate credentials through the installation procedures before applying resources.
Create Secrets in the selected namespace through the district credential process.
The generated List contains Secret references and selected keys only.
It never embeds raw credentials or creates Secret objects.
Every service receives only its selected credentials and trust material.
Administration and migration credentials remain outside ordinary API, frontend, worker, and edge pods.
The edge receives listener material and API/frontend trust. It verifies bootstrap credentials through the API.
Local PostgreSQL administrator Secret values must contain exact UTF-8 bytes without CR or LF characters.
The installer rejects reused administrator values with either line ending before applying resources.
It does not rewrite or log those values.

Generate Kestra runtime files with [the Kestra renderer](../kestra/README.md) on the operator workstation.
Use `CC_KESTRA_PROFILE=kubernetes` and `CC_KESTRA_RUNTIME_MOUNT_PATH=/run/kestra-runtime`.
Set the database JDBC URL to the configured Kestra database with `sslmode=verify-full` and the mounted CA path.
Set `CC_KESTRA_STORAGE_PATH` to the configured Kestra internal-storage location.
Set the worker endpoint and dispatch-secret file from the deployment configuration.
For private worker CAs, set `CC_KESTRA_WORKER_CA_FILE`.
The renderer generates the inbound PKCS12 keystore, outbound JVM truststore, and private authentication probe header.
Map those files to the keys declared in `kestraRuntime`.
Map `JAVA_OPTS` and `SECRET_CC_WORKER_DISPATCH_TOKEN` from `runtime-environment.json` to their declared Secret keys.
The pod uses explicit `secretKeyRef` environment mappings. It does not import an entire Secret into the environment.
Do not publish generated Kestra files or environment values in release evidence.

## Render and install

Run the renderer from the repository root:

```sh
npm exec nx run deployment:build
node deployment/kubernetes/cli.mjs /operator/deployment.json /operator/kubernetes.json /operator/resources.json
npm exec nx run deployment:kubernetes-test
```

Select the approved district context explicitly for every cluster command.
The operator must verify release integrity before applying the rendered List.
Create the namespace and separately prepared Secrets before the installation.
Then validate and apply:

```sh
kubectl --context DISTRICT_CONTEXT apply --dry-run=server -f /operator/resources.json
kubectl --context DISTRICT_CONTEXT apply -f /operator/resources.json
kubectl --context DISTRICT_CONTEXT -n CAMPUS_NAMESPACE wait --for=condition=complete job -l app.kubernetes.io/name=database-prepare --timeout=900s
kubectl --context DISTRICT_CONTEXT -n CAMPUS_NAMESPACE rollout status deployment/api --timeout=900s
kubectl --context DISTRICT_CONTEXT -n CAMPUS_NAMESPACE rollout status deployment/workers --timeout=900s
kubectl --context DISTRICT_CONTEXT -n CAMPUS_NAMESPACE get pods,pvc,services
```

The preparation Job name includes the source revision and configuration hash.
The Job provisions each local database independently, runs application migrations, and initializes temporary bootstrap access.
External database operators must provision roles and databases before this Job starts.
The Job never requests administration access to external databases.
API and worker init containers wait for the release migration and bootstrap row.
Kestra waits for its own database and runs its own migrations.
PostgreSQL Services publish starting pod addresses so preparation can connect before application roles exist.

Versioned immutable ConfigMaps preserve each rollout configuration.
Worker rollouts use zero surge and permit one unavailable worker to avoid anti-affinity deadlock on a full node set.
Database and Kestra deployments use `Recreate` because their qualified topology has one replica.
Retain prior release resources until upgrade and recovery validation finish.
Handle completed preparation Jobs through the release procedure before repeating the same installation attempt.

## Storage and service exposure

Application PostgreSQL and Kestra PostgreSQL use separate PVCs and separate roles.
Artifacts and Kestra internal storage use separate RWX PVCs and separate directory trees.
Nonroot init containers create private UID-1000 subdirectories before consumers mount those subdirectories.
`OnRootMismatch` limits repeated ownership changes on existing shared volumes.
The selected CSI driver must support these ownership operations.
Redis uses bounded `emptyDir` storage because its declared restart policy discards caches and sessions.
PostgreSQL remains authoritative.

The edge LoadBalancer provides Layer 4 ingress. It preserves HTTPS through the edge listener.
No HTTP Ingress controller or TLS verification bypass is required.
Internal Services remain ClusterIP services.
Network policies allow only declared component paths and DNS.
Kestra management port 8081 has no Service or ingress policy.
Node HTTPS probes connect to loopback while verifying the configured hostname and CA.
PostgreSQL probes use `sslmode=verify-full`. Kestra probes verify HTTPS and authentication.
TCP liveness probes test process reachability for stateful services. They do not establish dependency readiness.
API and edge readiness probes test their process listeners.
This keeps dependency diagnostics routable while another component fails.
The protected startup report remains the installation readiness gate across all eight components.
Worker and stateful readiness probes continue to test their required dependencies.

## Rescheduling evidence

Follow [the storage two-host procedure](../storage/cross-host.md) using the mounted artifact location and application database.
Run the write command in one worker pod and the read command in a worker pod on another node.
The worker image includes `/app/deployment/storage/cross-host.mjs` for this procedure.
Transfer only the descriptor evidence file. Do not copy artifact bytes between pods.
Record the source revision, pod names, node inventory identifiers, artifact ID, attempt ID, checksum, and size.

Use an approved spare node for the reschedule test.
Record the writer pod's node before deletion and the replacement pod's node after scheduling.
Require different node identifiers and a successful read of the previously published artifact.
Record PVC identity, storage class, CSI driver, mount configuration, restart duration, and all observed failures.
Do not accept a Pending replacement pod or a same-node restart as cross-node recovery.

## Qualification boundary

Six semantic tests and server-side validation passed against Kubernetes 1.35.8.
The workload fixture used Kind 0.33.0 with one control-plane node and two worker nodes.
Both synthetic namespaces reached eight ready Deployments through verified TLS.
Two API replicas and two worker replicas ran concurrently.
A replacement worker on another node read an existing artifact with the recorded checksum.

The restore adapter stopped every source writer before invoking the operations module.
It backed up both PostgreSQL databases, artifacts, Kestra internal storage, configuration, and release metadata.
It restored them into a separate namespace with fresh PVC identities and file roots.
The restored worker verified the artifact checksum.
The restored Kestra service exposed the flow and internal marker.
The restored Redis cache did not contain the source marker.

The adapter used one verified TLS database session per `kubectl port-forward` process.
It ran PostgreSQL 18.6 dump and restore tools inside the pinned database pods.
Separate evidence qualifies the operations module default native PostgreSQL 18.6 runner.

Kind hostPath mounts share one Docker host and do not qualify district RWX storage.
Kind's default CNI does not enforce NetworkPolicy.
The fixture did not qualify district CSI recovery or LoadBalancer behavior.
Local unpublished images do not qualify a signed release.

Kestra Open Source 1.3.37 runs one standalone replica. No Kestra high availability is claimed.
Its Flyway version warns that PostgreSQL 18.6 exceeds the tested range despite successful synthetic migrations.
The deployment retains that experimental compatibility limitation.
This profile does not qualify JobService failover, district throughput, or business-job execution.

[Kubernetes volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/) define access modes and storage-class binding.
[NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/) requires a supporting network implementation.
[Kubernetes probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) separate startup, liveness, and readiness behavior.

## Synthetic workload adapter

`integration.mjs` prepares Secrets and workloads only in the fixed `cc-workload-validation` Kind cluster.
It rejects an existing `cc-kube-synthetic` namespace to preserve active credentials.
Use `kind.synthetic.yaml`, `/tmp/cc-kube-workload-kubeconfig`, and the local qualification registry named `cc13-registry`.
The registry must contain the three exact image digests recorded in the adapter.
Run `npm exec nx run deployment:kubernetes-integration` after creating that disposable cluster.
The adapter requires Docker, kubectl, Node.js, OpenSSL, and keytool.
Its private temporary directory contains fixture credentials. Do not include that directory in evidence or releases.

The adapter provisions synthetic RWX claims over one shared host directory.
Their declared capacity does not measure available space or establish production capacity.
The executed fixture reached eight ready Deployments and preserved an artifact after a cross-node worker replacement.
`restore-integration.mjs` restores the source into `cc-kube-restore-synthetic` with fresh storage identities.
It records exact source and target mappings in `CC-17-kubernetes-result.json`.
See [CC-15 evidence](../evidence/CC-15.md) for the exact qualification boundary.
The [Kind local registry procedure](https://kind.sigs.k8s.io/docs/user/local-registry/) defines the containerd registry connection.
