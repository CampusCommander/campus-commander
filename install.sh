#!/bin/sh
# Download and verify a published Campus Commander installer before running it.
# Keep execution inside main so an incomplete pipe cannot execute a partial script.
main() {
  set -eu
  umask 077
  cc_repo=CampusCommander/campus-commander
  cc_identity=https://github.com/CampusCommander/campus-commander/.github/workflows/candidate-images.yml@refs/heads/implementation/cc-5-through-cc-20
  cc_issuer=https://token.actions.githubusercontent.com
  cc_release=
  cc_profile=
  cc_root=
  cc_answers=
  cc_command=
  cc_qualification=no
  cc_accept_license=no
  cc_dependencies=ask
  cc_verify_only=no
  cc_stage=
  cc_success=no
  cc_cache=${HOME:?Set HOME to the operator home directory.}/.cache/campus-commander

  cc_fail() { printf '%s\n' "Installation stopped: $*" >&2; exit 1; }
  cc_say() { printf '%s\n' "$*" >&2; }
  cc_prompt() {
    if ! (exec 3<>/dev/tty) 2>/dev/null; then
      cc_fail "A terminal is required. Use --answers, --profile, and --accept-license for automation."
    fi
    printf '%s ' "$1" >/dev/tty
    IFS= read -r cc_reply </dev/tty || cc_fail 'Terminal input ended.'
  }
  cc_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || cc_fail "Provide a value for $1."; }
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release) cc_value "$@"; cc_release=$2; shift 2 ;;
      --profile) cc_value "$@"; cc_profile=$2; shift 2 ;;
      --root) cc_value "$@"; cc_root=$2; shift 2 ;;
      --answers) cc_value "$@"; cc_answers=$2; shift 2 ;;
      --cache-dir) cc_value "$@"; cc_cache=$2; shift 2 ;;
      --command) cc_value "$@"; cc_command=$2; shift 2 ;;
      --qualification) cc_qualification=yes; shift ;;
      --accept-license) cc_accept_license=yes; shift ;;
      --install-dependencies) cc_dependencies=yes; shift ;;
      --no-install-dependencies) cc_dependencies=no; shift ;;
      --verify-only) cc_verify_only=yes; shift ;;
      --help|-h)
        cat <<'HELP'
Campus Commander hosted installer (Linux amd64)

Usage: sh install.sh [options]
  --profile all-docker|hybrid|kubernetes   Select an installation method.
  --root ABSOLUTE_PATH                    Set the private installation directory.
  --answers ABSOLUTE_PATH                 Supply guided setup answers as JSON.
  --release phase-1-candidate-REVISION12   Select an immutable candidate.
  --qualification                        Explicitly test an unaccepted candidate.
  --accept-license                       Accept the supplied community license.
  --install-dependencies                 Allow required Debian/Ubuntu packages.
  --no-install-dependencies              Refuse system package installation.
  --command install|resume|status         Select the installation operation.
  --cache-dir ABSOLUTE_PATH               Use a private download directory.
  --verify-only                          Verify a release without installation.

Without --release, select the newest published Phase 1 candidate.
The installer verifies signatures and checksums before executing release code.
Node and Cosign are downloaded privately when their pinned versions are absent.
Docker installation requires root or sudo and explicit permission.
Hybrid requires external services and shared storage. Kubernetes requires a cluster.
HELP
        return 0 ;;
      *) cc_fail "Unknown argument: $1. Use --help." ;;
    esac
  done
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || cc_fail 'Use a Linux amd64 installation host.'
  case "$cc_profile" in ''|all-docker|hybrid|kubernetes) ;; *) cc_fail 'Select all-docker, hybrid, or kubernetes.' ;; esac
  case "$cc_command" in ''|install|resume|status) ;; *) cc_fail 'Select install, resume, or status.' ;; esac
  if [ -n "$cc_release" ]; then
    printf '%s\n' "$cc_release" | LC_ALL=C grep -Eq '^phase-1-candidate-[a-f0-9]{12}$' || cc_fail 'Use a complete immutable candidate tag.'
  fi
  for cc_path in "$cc_cache" "$cc_root" "$cc_answers"; do
    case "$cc_path" in '') continue ;; /*) ;; *) cc_fail 'Use absolute paths for cache, installation, and answers.' ;; esac
    case "$cc_path" in *'/../'*|*'/./'*|*/..|*/.|*'//'*) cc_fail 'Use normalized absolute paths.' ;; esac
  done
  for cc_tool in curl tar sha256sum stat mktemp; do
    command -v "$cc_tool" >/dev/null 2>&1 || cc_fail "Install $cc_tool before running this command."
  done
  cc_parent=$cc_cache
  while [ "$cc_parent" != / ]; do
    [ ! -L "$cc_parent" ] || cc_fail 'The download directory must not contain symbolic links.'
    cc_parent=$(dirname "$cc_parent")
  done
  if [ ! -d "$cc_cache" ]; then mkdir -p -m 700 "$cc_cache"; fi
  [ "$(stat -c %u "$cc_cache")" = "$(id -u)" ] && [ "$(stat -c %a "$cc_cache")" = 700 ] || cc_fail 'Use a download directory owned by you with mode 700.'
  cc_stage=$(mktemp -d "$cc_cache/release.XXXXXXXX")
  cc_cleanup() {
    if [ "$cc_success" != yes ] && [ -n "$cc_stage" ]; then rm -rf -- "$cc_stage"; fi
  }
  trap cc_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cc_download() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --retry 3 --connect-timeout 20 --max-time 600 "$1" --output "$2"
  }
  cc_hash() { printf '%s  %s\n' "$2" "$1" | sha256sum --check --status; }
  cc_fetch_tool() {
    if [ ! -f "$cc_cache/$1" ] || ! cc_hash "$cc_cache/$1" "$3"; then
      cc_download "$2" "$cc_stage/tool.download"
      cc_hash "$cc_stage/tool.download" "$3" || cc_fail "The $1 checksum differs from its pinned checksum."
      mv -- "$cc_stage/tool.download" "$cc_cache/$1"
    fi
  }
  mkdir "$cc_stage/tools"
  if ! command -v node >/dev/null 2>&1 || [ "$(node --version 2>/dev/null)" != v24.19.0 ]; then
    cc_say 'Downloading Node.js 24.19.0 into the private installer directory.'
    cc_fetch_tool node-v24.19.0-linux-x64.tar.gz https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4
    tar -xzf "$cc_cache/node-v24.19.0-linux-x64.tar.gz" -C "$cc_stage/tools"
    PATH="$cc_stage/tools/node-v24.19.0-linux-x64/bin:$PATH"
    export PATH
  fi
  node --version >/dev/null || cc_fail 'Node requires a supported glibc Linux host. Use Ubuntu 24.04 or Debian 12 or later.'
  if ! command -v cosign >/dev/null 2>&1 || ! cosign version --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).gitVersion==="v3.1.3"?0:1)}catch{process.exit(1)}})'; then
    cc_say 'Downloading Cosign 3.1.3 into the private installer directory.'
    cc_fetch_tool cosign-linux-amd64-v3.1.3 https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
    cp "$cc_cache/cosign-linux-amd64-v3.1.3" "$cc_stage/tools/cosign"
    chmod 700 "$cc_stage/tools/cosign"
    PATH="$cc_stage/tools:$PATH"
    export PATH
  fi
  cc_existing=no
  cc_existing_root=${cc_root:-$HOME/.campus-commander}
  node -e '
    const fs=require("node:fs"),path=require("node:path");
    process.on("uncaughtException",e=>{console.error(e.message);process.exit(1)});
    const root=process.argv[1],out=process.argv[2];
    const operator=path.join(root,"operator.json"),pending=path.join(root,"setup-pending.json");
    const file=fs.existsSync(operator)?operator:fs.existsSync(pending)?pending:null;
    if(!file){fs.writeFileSync(out,"{}");process.exit(0);}
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||fs.realpathSync(file)!==file)throw Error("Existing setup must use a private regular file");
    const data=JSON.parse(fs.readFileSync(file));const o=file===operator?data:data.plan?.operator;
    if(!o||o.installationRoot!==root||o.configurationPath!==path.join(root,"deployment.json")||!path.isAbsolute(o.releaseRoot))throw Error("Existing installation binding differs");
    const manifest=JSON.parse(fs.readFileSync(path.join(o.releaseRoot,"release-manifest.json")));
    if(!/^[a-f0-9]{40}$/.test(manifest.sourceRevision))throw Error("Existing release identity is invalid");
    fs.writeFileSync(out,JSON.stringify({downloads:path.dirname(o.releaseRoot),tag:"phase-1-candidate-"+manifest.sourceRevision.slice(0,12)}));
  ' "$cc_existing_root" "$cc_stage/existing.json" || cc_fail 'Inspect the existing installation before resuming.'
  cc_saved_downloads=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).downloads||""' "$cc_stage/existing.json")
  if [ -n "$cc_saved_downloads" ]; then
    cc_saved_release=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).tag' "$cc_stage/existing.json")
    [ -z "$cc_release" ] || [ "$cc_release" = "$cc_saved_release" ] || cc_fail 'Use the installed release for resume. Use the documented upgrade procedure to change releases.'
    cc_release=$cc_saved_release
    cc_existing=yes
    cc_say "Using the original verified release for $cc_existing_root."
  fi
  if [ -z "$cc_release" ]; then
    cc_download "https://api.github.com/repos/$cc_repo/releases?per_page=100" "$cc_stage/releases.json"
    cc_release=$(node -e '
      const fs=require("node:fs"); const releases=JSON.parse(fs.readFileSync(process.argv[1]));
      if(!Array.isArray(releases))throw Error("Invalid release list");
      const release=releases.filter(r=>!r.draft&&/^phase-1-candidate-[a-f0-9]{12}$/.test(r.tag_name))
        .sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
      if(!release)throw Error("No published Phase 1 candidate exists");
      process.stdout.write(release.tag_name);
    ' "$cc_stage/releases.json") || cc_fail 'Could not select a published candidate. Retry or provide --release.'
  fi
  cc_say "Downloading $cc_release."
  for cc_asset in phase-1-candidate.tar.gz phase-1-candidate.sigstore.json release-manifest.json release-manifest.sigstore.json; do
    if [ "$cc_existing" = yes ]; then
      cp -- "$cc_saved_downloads/$cc_asset" "$cc_stage/$cc_asset" || cc_fail 'The original verified release files are missing.'
    else
      cc_download "https://github.com/$cc_repo/releases/download/$cc_release/$cc_asset" "$cc_stage/$cc_asset" || cc_fail "Download failed for $cc_asset."
    fi
  done
  cc_say 'Verifying the archive and release manifest signatures.'
  cosign verify-blob --bundle "$cc_stage/phase-1-candidate.sigstore.json" --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_stage/phase-1-candidate.tar.gz" || cc_fail 'Archive signature verification failed.'
  cosign verify-blob --bundle "$cc_stage/release-manifest.sigstore.json" --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_stage/release-manifest.json" || cc_fail 'Manifest signature verification failed.'
  tar -tzf "$cc_stage/phase-1-candidate.tar.gz" > "$cc_stage/archive-paths.txt"
  tar -tvzf "$cc_stage/phase-1-candidate.tar.gz" > "$cc_stage/archive-types.txt"
  node -e '
    process.on("uncaughtException",error=>{console.error(error.message);process.exit(1)});
    const fs=require("node:fs");const root=process.argv[1];
    const paths=fs.readFileSync(root+"/archive-paths.txt","utf8").trim().split("\n");
    const seen=new Set();
    for(let path of paths){path=path.replace(/^\.\//,"").replace(/\/$/,""); if(!path)continue;
      if(!/^[A-Za-z0-9_.\/-]+$/.test(path)||path.startsWith("/")||path.split("/").some(p=>!p||p==="."||p==="..")||seen.has(path))throw Error("Unsafe archive path");seen.add(path);}
    for(const line of fs.readFileSync(root+"/archive-types.txt","utf8").trim().split("\n")){if(!["-","d"].includes(line[0]))throw Error("Unsupported archive entry");}
  ' "$cc_stage" || cc_fail 'The archive contains unsafe paths or links.'
  mkdir "$cc_stage/bundle"
  tar --no-same-owner --no-same-permissions -xzf "$cc_stage/phase-1-candidate.tar.gz" -C "$cc_stage/bundle"
  node -e '
    process.on("uncaughtException",error=>{console.error(error.message);process.exit(1)});
    const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
    const root=process.argv[1],tag=process.argv[2],manifestBytes=fs.readFileSync(root+"/release-manifest.json");
    if(!manifestBytes.equals(fs.readFileSync(root+"/bundle/release-manifest.json")))throw Error("Archive and external manifests differ");
    const manifest=JSON.parse(manifestBytes);
    if(manifest.schemaVersion!==1||!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)||tag!=="phase-1-candidate-"+manifest.sourceRevision.slice(0,12))throw Error("Release identity differs");
    if(JSON.stringify(manifest.architectures)!==JSON.stringify(["linux/amd64"]))throw Error("Unsupported release architecture");
    if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>10000)throw Error("Invalid file inventory");
    const seen=new Set();
    for(const item of manifest.files){
      if(typeof item.path!=="string"||!/^[A-Za-z0-9_.\/-]+$/.test(item.path)||item.path.startsWith("/")||item.path.split("/").some(x=>!x||x==="."||x==="..")||seen.has(item.path))throw Error("Invalid inventory path");
      seen.add(item.path);let filename=root+"/bundle";
      for(const part of item.path.split("/")){filename=path.join(filename,part);if(fs.lstatSync(filename).isSymbolicLink())throw Error("Unexpected symbolic link");}
      const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.size>64*1024*1024||stat.size!==item.sizeBytes)throw Error("Invalid release file");
      if(crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex")!==item.sha256)throw Error("Release file checksum differs");
    }
    for(const file of ["deployment/installer/setup.mjs","LICENSE.md"]){if(!seen.has(file))throw Error("Release lacks the hosted installer or license. Select a newer candidate.");}
    const images=[];for(const [key,name] of [["frontend","frontend"],["api","api"],["workers","worker"]]){
      const image=manifest.images?.[key];if(typeof image!=="string"||!new RegExp("^ghcr\\.io/campuscommander/campus-commander-"+name+"@sha256:[a-f0-9]{64}$").test(image))throw Error("Unexpected application image");images.push(image);}
    fs.writeFileSync(root+"/images.txt",images.join("\n")+"\n",{mode:0o600});
  ' "$cc_stage" "$cc_release" || cc_fail 'Release integrity verification failed.'
  if [ "$cc_existing" != yes ] || [ "$cc_verify_only" = yes ]; then
  while IFS= read -r cc_image; do
    cc_say "Verifying $cc_image"
    cosign verify --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_image" > "$cc_stage/image-verification.json" || cc_fail 'Image signature verification failed. Confirm registry access and retry.'
  done < "$cc_stage/images.txt"
  fi
  cp "$cc_stage/release-manifest.sigstore.json" "$cc_stage/bundle/release-manifest.sigstore.json"
  cc_say 'Release signatures and file checksums passed.'
  if [ "$cc_verify_only" = yes ]; then
    cc_success=yes
    cc_say "Verified release: $cc_stage/bundle"
    return 0
  fi
  if [ "$cc_accept_license" != yes ]; then
    cc_say "License: $cc_stage/bundle/LICENSE.md"
    cc_say 'Free use covers eligible public education and nonprofits providing all services free. Other use requires a paid agreement.'
    cc_prompt 'Accept the supplied license for your authorized use? [yes/no]'
    [ "$cc_reply" = yes ] || cc_fail 'License acceptance is required.'
  fi
  if [ -z "$cc_profile" ] && [ -n "$cc_answers" ]; then
    cc_profile=$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(a.profile||"")' "$cc_answers")
  fi
  if [ -z "$cc_profile" ]; then
    cc_say '1) All-Docker: application and dependencies on this host.'
    cc_say '2) Hybrid: external databases, Redis, shared storage, and worker hosts.'
    cc_say '3) Kubernetes: an existing cluster and configured storage.'
    cc_prompt 'Installation method [1/2/3] (default 1):'
    case "$cc_reply" in ''|1|all-docker) cc_profile=all-docker ;; 2|hybrid) cc_profile=hybrid ;; 3|kubernetes) cc_profile=kubernetes ;; *) cc_fail 'Select 1, 2, or 3.' ;; esac
  fi
  case "$cc_profile" in all-docker|hybrid|kubernetes) ;; *) cc_fail 'Select all-docker, hybrid, or kubernetes.' ;; esac
  cc_as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else command -v sudo >/dev/null 2>&1 || cc_fail 'Root or sudo is required to install system packages.'; sudo "$@"; fi; }
  cc_allow_packages() {
    if [ "$cc_dependencies" = ask ]; then
      cc_say "$1"
      cc_prompt 'Install these system prerequisites using apt? [yes/no]'
      [ "$cc_reply" = yes ] && cc_dependencies=yes || cc_dependencies=no
    fi
    [ "$cc_dependencies" = yes ] || cc_fail 'Install the listed prerequisites, then repeat this command.'
    [ -r /etc/os-release ] || cc_fail 'Automatic package installation supports Ubuntu and Debian.'
    . /etc/os-release
    case "${ID:-}" in ubuntu|debian) ;; *) cc_fail 'Automatic package installation supports Ubuntu and Debian.' ;; esac
    command -v apt-get >/dev/null 2>&1 || cc_fail 'Install the prerequisites with your system package manager.'
  }
  if ! command -v openssl >/dev/null 2>&1; then
    cc_allow_packages 'OpenSSL is required for certificate preparation.'
    cc_as_root apt-get update
    cc_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y openssl ca-certificates
  fi
  if [ "$cc_profile" = hybrid ] && ! command -v keytool >/dev/null 2>&1; then
    cc_allow_packages 'A Java runtime with keytool is required for hybrid service certificates.'
    cc_as_root apt-get update
    cc_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y default-jre-headless
  fi
  if [ "$cc_profile" = kubernetes ]; then
    if ! command -v kubectl >/dev/null 2>&1; then
      cc_fetch_tool kubectl-v1.35.8 https://dl.k8s.io/release/v1.35.8/bin/linux/amd64/kubectl 874d5e72dbb819f43cff16bcd1e4f8bac5b7f2361fe1e55049b0a6c676fb0cbf
      cp "$cc_cache/kubectl-v1.35.8" "$cc_stage/tools/kubectl"
      chmod 700 "$cc_stage/tools/kubectl"
      PATH="$cc_stage/tools:$PATH"
      export PATH
    fi
  elif ! command -v docker >/dev/null 2>&1; then
    cc_allow_packages 'Docker Engine, its Compose plugin, and containerd are required.'
    cc_codename=${VERSION_CODENAME:-}
    printf '%s\n' "$cc_codename" | LC_ALL=C grep -Eq '^[a-z]+$' || cc_fail 'The distribution codename is unsupported.'
    cc_download "https://download.docker.com/linux/$ID/gpg" "$cc_stage/docker.asc"
    cc_hash "$cc_stage/docker.asc" 1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570 || cc_fail 'Docker repository key checksum differs.'
    cc_as_root install -m 0755 -d /etc/apt/keyrings
    cc_as_root install -m 0644 "$cc_stage/docker.asc" /etc/apt/keyrings/campus-commander-docker.asc
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/campus-commander-docker.asc\n' "$ID" "$cc_codename" > "$cc_stage/docker.sources"
    cc_as_root install -m 0644 "$cc_stage/docker.sources" /etc/apt/sources.list.d/campus-commander-docker.sources
    cc_as_root apt-get update
    cc_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then cc_as_root systemctl start docker; fi
  fi
  if [ "$cc_profile" != kubernetes ]; then
    if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && [ "$(id -u)" != 0 ] && [ -x /usr/bin/docker ] && command -v sudo >/dev/null 2>&1; then
      cc_say 'Docker requires elevated access. The installer will use sudo for Docker commands only.'
      if [ -n "$cc_answers" ]; then sudo -n true || cc_fail 'Authorize sudo before unattended installation.';
      else sudo -v </dev/tty || cc_fail 'Docker access requires sudo authorization.'; fi
      printf '#!/bin/sh\nexec sudo -n /usr/bin/docker "$@"\n' > "$cc_stage/tools/docker"
      chmod 700 "$cc_stage/tools/docker"
      PATH="$cc_stage/tools:$PATH"
      export PATH
    fi
    docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || cc_fail 'Start Docker and grant this operator access to its socket, then repeat the command.'
    docker compose version --short >/dev/null 2>&1 || cc_fail 'Install the Docker Compose plugin, then repeat the command.'
  fi
  set -- --release-root "$cc_stage/bundle" --profile "$cc_profile"
  if [ -n "$cc_command" ]; then set -- "$@" --command "$cc_command"; fi
  if [ -n "$cc_root" ]; then set -- "$@" --root "$cc_root"; fi
  if [ -n "$cc_answers" ]; then set -- "$@" --answers "$cc_answers"; fi
  if [ "$cc_qualification" = yes ]; then set -- "$@" --qualification; fi
  # Preserve verified files after setup starts. Resume reads their stable paths.
  cc_success=yes
  if [ -n "$cc_answers" ]; then
    node "$cc_stage/bundle/deployment/installer/setup.mjs" "$@" </dev/null
  else
    node "$cc_stage/bundle/deployment/installer/setup.mjs" "$@" </dev/tty
  fi
}
main "$@"
