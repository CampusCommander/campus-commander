# Phase 1 application images

Nx builds the frontend, API, and worker images for Linux amd64.
Each Dockerfile uses the root `package-lock.json` and a pinned Node base image digest.
Each runtime uses the image `node` account.

TLS listeners require `TLS_CERT_FILE` and `TLS_KEY_FILE`.
Set `TLS_SERVER_NAME` to the certificate DNS name for health checks.
Set `TLS_CA_FILE` when the certificate issuer differs from the server certificate.

Run these local image builds:

```text
npm exec -- nx run-many -t image -p frontend api worker
```

The targets create these candidate tags:

```text
campus-commander/frontend:cc-6
campus-commander/api:cc-6
campus-commander/worker:cc-6
```

Registry publication requires project-approved GHCR package names and package write access.
Authenticate Docker without placing the token in command arguments.
Then publish each candidate with the script below.

```text
node deployment/images/publish-candidate.mjs frontend ghcr.io/campuscommander/campus-commander-frontend:<candidate-tag>
node deployment/images/publish-candidate.mjs api ghcr.io/campuscommander/campus-commander-api:<candidate-tag>
node deployment/images/publish-candidate.mjs worker ghcr.io/campuscommander/campus-commander-worker:<candidate-tag>
```

Record the registry manifest digest after publication.
Use that digest in every profile without rebuilding the image.

After pulling all three references, create a checked release manifest:

```text
node deployment/images/create-release-manifest.mjs <output.json> <frontend-reference> <api-reference> <worker-reference>
```

The command rejects images without repository digests.
It also rejects images outside Linux amd64 or images that use another runtime account.
