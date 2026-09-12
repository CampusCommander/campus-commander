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
  cc_sudo=no
  cc_container_daemon_started=no
  cc_color=
  cc_reset=
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
  # Host preparation helpers also run in the isolated prerequisite test harness.
  cc_step() { printf '\n%s%s%s\n' "$cc_color" "$*" "$cc_reset" >&2; }
  cc_status() { printf '  %-18s %s\n' "$1" "$2" >&2; }
  cc_has_terminal() { (exec 3<>/dev/tty) 2>/dev/null; }
  cc_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }
  cc_container() { [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "${container:-}" ]; }
  cc_container_capable() {
    while read -r cc_cap_name cc_cap_value; do
      if [ "$cc_cap_name" = CapBnd: ]; then
        [ "$((0x$cc_cap_value & 0x201000))" -eq "$((0x201000))" ]
        return
      fi
    done < /proc/self/status
    return 1
  }
  cc_container_instructions() {
    cc_say 'This container needs Docker nesting permissions from the machine that created it.'
    cc_say 'The privileged option grants broad host access. Use a dedicated test container and separate Docker storage.'
    cc_say 'Run these commands in a terminal on the Docker host to create a new container:'
    cc_say 'docker run -d --name cc-install --privileged --init --cgroupns=private --mount source=cc-install-docker,target=/var/lib/docker --mount source=cc-install-home,target=/root -p 127.0.0.1:8443:8443 ubuntu:24.04 sleep infinity'
    cc_say 'docker exec -it cc-install bash'
    cc_say 'Then run this install script inside that container. Keep the existing container until you recover any required files.'
  }
  cc_os() {
    cc_distribution=unknown
    cc_codename=
    cc_os_label=$(uname -s)
    if [ -r /etc/os-release ]; then
      . /etc/os-release
      cc_distribution=${ID:-unknown}
      cc_codename=${VERSION_CODENAME:-}
      cc_os_label=${PRETTY_NAME:-$cc_distribution}
    fi
  }
  cc_apt_supported() {
    case "$cc_distribution" in ubuntu|debian) command -v apt-get >/dev/null 2>&1 ;; *) return 1 ;; esac
  }
  cc_authorize() {
    [ "$(id -u)" != 0 ] || return 0
    command -v sudo >/dev/null 2>&1 || cc_fail 'Use an account with sudo access or ask your administrator to run the listed commands.'
    if [ -n "$cc_answers" ] || ! cc_has_terminal; then
      sudo -n -v || cc_fail 'Sudo authorization is unavailable. Run sudo -v in your terminal, then repeat the installer.'
    else
      if [ "$cc_sudo" != yes ]; then
        cc_say 'Sudo will request your password through the terminal. The installer does not read or store it.'
      fi
      sudo -v </dev/tty || cc_fail 'Sudo authorization failed. Repeat the installer with an authorized account.'
    fi
    cc_sudo=yes
  }
  cc_as_root() {
    if [ "$(id -u)" = 0 ]; then "$@" </dev/null
    else cc_authorize; sudo -n "$@" </dev/null
    fi
  }
  cc_run_system_step() {
    cc_system_label=$1
    shift
    cc_authorize
    if command -v mktemp >/dev/null 2>&1; then
      if [ -n "$cc_stage" ]; then cc_system_log=$(mktemp "$cc_cache/prerequisites.XXXXXXXX.log")
      else cc_system_log=$(mktemp "${TMPDIR:-/tmp}/cc-prerequisites.XXXXXXXX.log")
      fi
      cc_status 'System task' "$cc_system_label"
      cc_say "  Detailed output: $cc_system_log"
      if ! cc_as_root "$@" > "$cc_system_log" 2>&1; then
        cc_fail "$cc_system_label failed. Review $cc_system_log, then repeat the installer."
      fi
    else
      cc_as_root "$@" || cc_fail "$cc_system_label failed. Review the package output, then repeat the installer."
    fi
  }
  cc_choose_repair() {
    cc_say "$1"
    cc_say 'Proposed action:'
    cc_say "$2"
    case "$cc_dependencies" in
      yes) return 0 ;;
      no) cc_say "$3"; cc_fail 'Automatic changes are disabled. Complete these instructions, then repeat the installer.' ;;
    esac
    if [ -n "$cc_answers" ] || ! cc_has_terminal; then
      cc_say "$3"
      cc_fail 'Repeat with --install-dependencies to authorize these changes, or complete the instructions manually.'
    fi
    while :; do
      cc_say '1) Install automatically'
      cc_say '2) Show instructions'
      cc_say '3) Cancel'
      cc_prompt 'Choose [1/2/3] (default 1):'
      case "$cc_reply" in
        ''|1|yes) return 0 ;;
        2|instructions)
          cc_say "$3"
          cc_prompt 'Press Enter to check again, or type cancel:'
          [ -z "$cc_reply" ] && return 2
          cc_fail 'Installation cancelled. Repeat the installer when you are ready.' ;;
        3|no|cancel) cc_fail 'Installation cancelled. No changes from this action were applied.' ;;
        *) cc_say 'Enter 1, 2, or 3.' ;;
      esac
    done
  }
  cc_packages() {
    cc_apt_supported || cc_fail "Automatic package installation supports Ubuntu and Debian. Install these packages with your administrator: $*"
    cc_run_system_step 'Update package indexes' apt-get update
    cc_run_system_step 'Install prerequisite packages' env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove "$@"
  }
  cc_base_missing() {
    cc_missing=
    command -v curl >/dev/null 2>&1 || cc_missing="$cc_missing curl"
    command -v tar >/dev/null 2>&1 || cc_missing="$cc_missing tar"
    command -v gzip >/dev/null 2>&1 || cc_missing="$cc_missing gzip"
    for cc_tool in sha256sum stat mktemp; do
      if ! command -v "$cc_tool" >/dev/null 2>&1; then cc_missing="$cc_missing coreutils"; break; fi
    done
    [ -s /etc/ssl/certs/ca-certificates.crt ] || cc_missing="$cc_missing ca-certificates"
  }
  cc_prepare_base() {
    while :; do
      cc_base_missing
      [ -n "$cc_missing" ] || break
      cc_apt_supported || cc_fail "Install the HTTPS and archive tools with your package manager:$cc_missing. Then repeat this script."
      if cc_choose_repair "Missing download tools:$cc_missing" "Install from the configured system repositories:$cc_missing" \
        "Run: sudo apt-get update
Run: sudo apt-get install --no-remove$cc_missing"; then
        # The package list contains only the fixed names from cc_base_missing.
        cc_packages $cc_missing
        cc_base_missing
        [ -z "$cc_missing" ] || cc_fail "Packages remain unavailable:$cc_missing. Check the package manager output."
      fi
    done
    cc_status 'Download tools' 'ready'
  }
  cc_environment() {
    cc_os
    cc_step '1 / 5  Check this environment'
    cc_status 'Operating system' "$cc_os_label"
    cc_status 'Architecture' "$(uname -m)"
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] ||
      cc_fail 'Use an Ubuntu 24.04 amd64 VM or a supported Linux amd64 host. Run this script inside that environment.'
    if cc_container; then cc_status 'Environment' 'container'
    elif uname -r | grep -qi microsoft; then cc_status 'Environment' 'WSL'
    else cc_status 'Environment' 'Linux host or virtual machine'
    fi
    if [ "$(id -u)" = 0 ]; then cc_status 'System changes' 'root access'
    elif command -v sudo >/dev/null 2>&1; then cc_status 'System changes' 'sudo available when needed'
    else cc_status 'System changes' 'administrator assistance required for missing dependencies'
    fi
  }
  cc_host_route() {
    [ "$cc_profile" != kubernetes ] || return 0
    if command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
      cc_status 'Docker daemon' 'reachable'
      return 0
    fi
    if cc_container && ! cc_systemd; then
      if ! cc_container_capable; then
        cc_container_instructions
        cc_fail 'Container nesting permissions are missing. The installer cannot grant host permissions from inside this container.'
      fi
      cc_status 'Docker daemon' 'can prepare a private daemon inside this container'
      return 0
    fi
    cc_status 'Docker daemon' 'needs preparation after release verification'
  }
  cc_select_profile() {
    while [ -z "$cc_profile" ]; do
      cc_step 'Choose how to install Campus Commander'
      cc_say '1) All-Docker (recommended): install the application and its services on this machine.'
      cc_say '2) Hybrid: connect district databases, Redis, shared storage, and separate worker hosts.'
      cc_say '3) Kubernetes: deploy to a cluster that your district already operates.'
      cc_prompt 'Installation method [1/2/3] (default 1):'
      case "$cc_reply" in
        ''|1|all-docker) cc_profile=all-docker ;;
        2|hybrid) cc_profile=hybrid ;;
        3|kubernetes) cc_profile=kubernetes ;;
        *) cc_say 'Enter 1, 2, or 3.' ;;
      esac
    done
  }
  cc_require_package_tool() {
    while ! command -v "$1" >/dev/null 2>&1; do
      if cc_choose_repair "$3" "Install package $2 from your system repositories." \
        "Run: sudo apt-get update
Run: sudo apt-get install --no-remove $2"; then
        cc_packages "$2"
        command -v "$1" >/dev/null 2>&1 || cc_fail "The package did not provide $1. Review the package output."
      fi
    done
    cc_status "$1" 'ready'
  }
  cc_docker_repository() {
    cc_apt_supported || cc_fail 'Use the Docker Engine installation instructions for your distribution: https://docs.docker.com/engine/install/'
    printf '%s\n' "$cc_codename" | LC_ALL=C grep -Eq '^[a-z]+$' || cc_fail 'The distribution codename is unsupported.'
    cc_download "https://download.docker.com/linux/$cc_distribution/gpg" "$cc_stage/docker.asc"
    cc_hash "$cc_stage/docker.asc" 1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570 || cc_fail 'Docker repository key checksum differs.'
    cc_as_root install -m 0755 -d /etc/apt/keyrings
    cc_as_root install -m 0644 "$cc_stage/docker.asc" /etc/apt/keyrings/campus-commander-docker.asc
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/campus-commander-docker.asc\n' "$cc_distribution" "$cc_codename" > "$cc_stage/docker.sources"
    cc_as_root install -m 0644 "$cc_stage/docker.sources" /etc/apt/sources.list.d/campus-commander-docker.sources
  }
  cc_docker_local() {
    [ -z "${DOCKER_HOST:-}" ] && [ -z "${DOCKER_CONTEXT:-}" ] &&
      [ "$(docker context show 2>/dev/null)" = default ] &&
      [ "$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" = unix:///var/run/docker.sock ]
  }
  cc_platform_passes() {
    node --input-type=module -e '
      const {pathToFileURL}=await import("node:url");
      const {evaluatePlatformVersion}=await import(pathToFileURL(process.argv[1]));
      process.exit(evaluatePlatformVersion(process.argv[2],process.argv[3]).passed?0:1);
    ' "$cc_stage/bundle/deployment/installer/platforms.mjs" "$1" "$2"
  }
  cc_docker_package_version() {
    apt-cache madison "$1" | node --input-type=module -e '
      const {pathToFileURL}=await import("node:url");
      const {evaluatePlatformVersion}=await import(pathToFileURL(process.argv[1]));
      let text="";for await(const chunk of process.stdin)text+=chunk;
      const versions=text.split("\n").map(line=>line.split("|")[1]?.trim()).filter(Boolean);
      const number=v=>v.replace(/^\d+:/,"").split("-")[0];
      const compatible=versions.filter(v=>evaluatePlatformVersion(process.argv[2],number(v)).passed)
        .sort((a,b)=>number(b).localeCompare(number(a),"en",{numeric:true}));
      if(!compatible.length)process.exit(1);process.stdout.write(compatible[0]);
    ' "$cc_stage/bundle/deployment/installer/platforms.mjs" "$2"
  }
  cc_install_docker_packages() {
    cc_docker_repository
    cc_run_system_step 'Update Docker package indexes' apt-get update
    cc_compose_version=$(cc_docker_package_version docker-compose-plugin dockerCompose) ||
      cc_fail 'The repository has no compatible Compose package for this release. Ask your administrator to check available versions.'
    if [ "$1" = compose ]; then
      cc_run_system_step 'Install Docker Compose' env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove "docker-compose-plugin=$cc_compose_version"
    else
      cc_engine_version=$(cc_docker_package_version docker-ce dockerEngine) ||
        cc_fail 'The repository has no compatible Docker Engine package for this release. Ask your administrator to check available versions.'
      cc_say 'Existing package removals and forced downgrades are disabled.'
      cc_run_system_step 'Install Docker Engine and Compose' env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove \
        "docker-ce=$cc_engine_version" "docker-ce-cli=$cc_engine_version" containerd.io docker-buildx-plugin "docker-compose-plugin=$cc_compose_version"
    fi
  }
  cc_enable_docker_access() {
    [ "$(id -u)" != 0 ] && [ -x /usr/bin/docker ] || return 1
    cc_docker_local || return 1
    if cc_choose_repair 'The current account cannot reach the local Docker daemon.' \
      'Use sudo for Docker commands during this installation. Docker access grants administrative control of this host.' \
      'Run: sudo docker info. For permanent access, follow https://docs.docker.com/engine/install/linux-postinstall/'; then
      cc_authorize
      sudo -n /usr/bin/docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}' >/dev/null 2>&1 || return 1
      if [ -n "$cc_answers" ]; then
        printf '#!/bin/sh\nexec sudo -n /usr/bin/docker --host unix:///var/run/docker.sock "$@"\n' > "$cc_stage/tools/docker"
      else
        printf '#!/bin/sh\nexec sudo /usr/bin/docker --host unix:///var/run/docker.sock "$@"\n' > "$cc_stage/tools/docker"
      fi
      chmod 700 "$cc_stage/tools/docker"
      PATH="$cc_stage/tools:$PATH"
      export PATH
      cc_status 'Docker access' 'sudo for Docker only. No logout required.'
    fi
  }
  cc_start_container_docker() {
    cc_container_capable || { cc_container_instructions; cc_fail 'Container nesting permissions are missing.'; }
    if cc_choose_repair 'This container has no running local Docker daemon.' \
      'Prepare nested resource limits and start a private Docker daemon using /var/lib/docker and a local Unix socket.' \
      'Use a container runtime that prepares nested cgroups, such as Docker-in-Docker. See https://hub.docker.com/_/docker. Then recheck here.'; then
      cc_say 'Keep /var/lib/docker and your installation directory on dedicated persistent volumes.'
      cc_say 'Daemon log: /var/log/campus-commander/dockerd.log'
      cc_as_root /bin/sh -c '
        set -eu
        umask 077
        mkdir -p /var/log/campus-commander
        if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
          case "$(cat /proc/1/cgroup)" in
            0::/|0::/cc-installer-init) ;;
            *) printf "%s\n" "Use a private cgroup namespace for nested Docker (--cgroupns=private)." >&2; exit 1 ;;
          esac
          mkdir -p /sys/fs/cgroup/cc-installer-init
          attempt=0
          while :; do
            while read -r process; do
              printf "%s\n" "$process" > /sys/fs/cgroup/cc-installer-init/cgroup.procs 2>/dev/null || true
            done < /sys/fs/cgroup/cgroup.procs
            if (printf "+cpu +memory +pids\n" > /sys/fs/cgroup/cgroup.subtree_control) 2>/dev/null; then break; fi
            attempt=$((attempt + 1))
            [ "$attempt" -lt 5 ] || { printf "%s\n" "Cannot delegate CPU, memory, and process controllers. Restart this dedicated outer container, then repeat." >&2; exit 1; }
            sleep 1
          done
          mkdir -p /sys/fs/cgroup/cc-installer-workloads
        fi
        namespace=$(stat -Lc %i /proc/1/ns/pid)
        case "$namespace" in ""|*[!0-9]*) exit 1 ;; esac
        runtime=/run/campus-commander/docker-$namespace
        mkdir -p "$runtime"
        if [ -s "$runtime/daemon.pid" ]; then
          previous=
          read -r previous < "$runtime/daemon.pid" || [ -n "$previous" ]
          case "$previous" in ""|*[!0-9]*) exit 1 ;; esac
          if kill -0 "$previous" 2>/dev/null; then exit 1; fi
          rm "$runtime/daemon.pid"
        fi
        export container=docker
        nohup /usr/bin/dockerd --host unix:///var/run/docker.sock --pidfile "$runtime/daemon.pid" --exec-root "$runtime/exec" \
          --cgroup-parent /cc-installer-workloads \
          > /var/log/campus-commander/dockerd.log 2>&1 < /dev/null &
      ' || cc_fail 'Docker startup failed. Inspect /var/log/campus-commander/dockerd.log before repeating.'
      cc_attempt=0
      while [ "$cc_attempt" -lt 30 ]; do
        if cc_as_root /usr/bin/docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}' >/dev/null 2>&1; then
          cc_container_daemon_started=yes
          return 0
        fi
        cc_attempt=$((cc_attempt + 1))
        sleep 1
      done
      cc_fail 'Docker did not become ready. Inspect /var/log/campus-commander/dockerd.log and the container nesting permissions.'
    fi
  }
  cc_prepare_docker() {
    while ! command -v docker >/dev/null 2>&1; do
      if cc_choose_repair 'Docker Engine is missing.' \
        'Add the verified Docker apt repository. Install Docker Engine, containerd, Buildx, and Compose. Package installation starts Docker.' \
        "Follow https://docs.docker.com/engine/install/$cc_distribution/ and install Docker Engine with the Compose plugin."; then
        if ! cc_systemd; then
          cc_container && cc_container_capable || cc_fail 'Enable a system service manager or use a container with Docker nesting permissions.'
        fi
        cc_install_docker_packages engine
        command -v docker >/dev/null 2>&1 || cc_fail 'Docker installation did not provide the Docker command.'
      fi
    done
    while ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
      cc_docker_local || cc_fail 'The selected Docker endpoint is unavailable. Restore that endpoint or select the intended local context, then repeat.'
      if cc_container && ! cc_systemd; then
        if ! command -v dockerd >/dev/null 2>&1; then
          if cc_choose_repair 'The Docker client is installed, but its daemon is missing.' \
            'Install compatible Docker Engine packages for this container.' \
            "Follow https://docs.docker.com/engine/install/$cc_distribution/ to install Docker Engine."; then
            cc_install_docker_packages engine
            command -v dockerd >/dev/null 2>&1 || cc_fail 'Docker Engine installation did not provide dockerd.'
          else continue
          fi
        fi
        cc_start_container_docker
      elif cc_systemd && ! systemctl is-active --quiet docker; then
        if cc_choose_repair 'The local Docker service is stopped.' 'Start the Docker service with systemctl.' \
          'Run: sudo systemctl start docker. Then run: sudo docker info'; then
          cc_as_root systemctl start docker || cc_fail 'Docker did not start. Run sudo journalctl -u docker --no-pager -n 50 to inspect it.'
        else continue
        fi
      fi
      docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && break
      cc_enable_docker_access || cc_fail 'Docker remains unavailable. Run sudo docker info and inspect the daemon error before repeating.'
    done
    while ! docker compose version --short >/dev/null 2>&1; do
      if cc_choose_repair 'Docker is running, but the Compose plugin is missing.' \
        'Add the verified Docker apt repository and install docker-compose-plugin.' \
        "Follow https://docs.docker.com/compose/install/linux/ to install the Compose plugin."; then
        cc_install_docker_packages compose
        docker compose version --short >/dev/null 2>&1 || cc_fail 'Compose is still unavailable. Inspect the package output.'
      fi
    done
    cc_engine=$(docker version --format '{{.Server.Version}}')
    cc_compose=$(docker compose version --short)
    if ! cc_platform_passes dockerEngine "$cc_engine" || ! cc_platform_passes dockerCompose "$cc_compose"; then
      if cc_choose_repair "Installed versions do not match this release: Docker $cc_engine, Compose $cc_compose." \
        'Install compatible Docker and Compose packages. A Docker package upgrade can restart existing containers on this host.' \
        "Review the release requirements in $cc_stage/bundle/deployment/installer/platforms.mjs and schedule the Docker upgrade with your administrator."; then
        cc_docker_local || cc_fail 'Update the selected Docker daemon through its administrator. This installer only repairs the default local daemon.'
        cc_install_docker_packages engine
      fi
      cc_platform_passes dockerEngine "$(docker version --format '{{.Server.Version}}')" &&
        cc_platform_passes dockerCompose "$(docker compose version --short)" ||
        cc_fail 'Docker versions still differ from the release requirements. Complete the manual instructions, then repeat the installer.'
    fi
    cc_status 'Docker Engine' "$(docker version --format '{{.Server.Version}}')"
    cc_status 'Docker Compose' "$(docker compose version --short)"
  }
  cc_recover_container_installation() {
    [ "$cc_container_daemon_started" = yes ] && [ "$cc_existing" = yes ] && [ "$cc_profile" = all-docker ] || return 0
    if [ -z "$cc_command" ] && [ -z "$cc_answers" ]; then
      while :; do
        cc_prompt 'Docker restarted. Resume services in dependency order, or inspect status? [resume/status] (default resume):'
        case "$cc_reply" in ''|resume) cc_command=resume; break ;; status) cc_command=status; break ;; esac
      done
    fi
    case "$cc_command" in
      resume|install)
        cc_say 'Docker restarted existing containers before their dependencies. Restoring this installation in dependency order.'
        cc_say 'The installer will stop this installation, preserve its data, and resume its services.'
        cc_saved_qualification=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).qualification===true?"yes":"no"' "$cc_existing_root/setup-record.json")
        set -- stop "$cc_existing_root/operator.json"
        if [ "$cc_saved_qualification" = yes ]; then set -- "$@" --qualification; fi
        node "$cc_stage/bundle/deployment/installer/cli.mjs" "$@" > "$cc_stage/container-recovery.json" ||
          cc_fail "Service ordering recovery stopped. Inspect $cc_existing_root/installer-state.json before repeating."
        ;;
      *) cc_say 'Use --command resume to restore service startup order after this daemon restart.' ;;
    esac
  }
  # End host preparation helpers.
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
  --release phase-2-qualified-REVISION12   Select an immutable prerelease. Candidate tags remain supported.
  --qualification                        Explicitly test an unaccepted candidate.
  --accept-license                       Accept the supplied community license.
  --install-dependencies                 Allow proposed prerequisite repairs.
  --no-install-dependencies              Show manual prerequisite instructions.
  --command install|resume|status         Select the installation operation.
  --cache-dir ABSOLUTE_PATH               Use a private download directory.
  --verify-only                          Verify a release without installation.

Without --release, select the newest published candidate.
The installer verifies signatures and checksums before executing release code.
Node and Cosign are downloaded privately when their pinned versions are absent.
Missing prerequisites offer automatic repair, manual instructions, or cancellation.
System changes require root or terminal-based sudo and explicit permission.
Hybrid requires external services and shared storage. Kubernetes requires a cluster.
HELP
        return 0 ;;
      *) cc_fail "Unknown argument: $1. Use --help." ;;
    esac
  done
  case "$cc_profile" in ''|all-docker|hybrid|kubernetes) ;; *) cc_fail 'Select all-docker, hybrid, or kubernetes.' ;; esac
  case "$cc_command" in ''|install|resume|status) ;; *) cc_fail 'Select install, resume, or status.' ;; esac
  if [ -n "$cc_release" ]; then
    printf '%s\n' "$cc_release" | LC_ALL=C grep -Eq '^phase-([12]-candidate|2-qualified)-[a-f0-9]{12}$' || cc_fail 'Use a complete immutable release tag.'
  fi
  for cc_path in "$cc_cache" "$cc_root" "$cc_answers"; do
    case "$cc_path" in '') continue ;; /*) ;; *) cc_fail 'Use absolute paths for cache, installation, and answers.' ;; esac
    case "$cc_path" in *'/../'*|*'/./'*|*/..|*/.|*'//'*) cc_fail 'Use normalized absolute paths.' ;; esac
  done
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    cc_color=$(printf '\033[1;36m')
    cc_reset=$(printf '\033[0m')
  fi
  cc_step 'Campus Commander Installer'
  cc_say 'We will check this environment, prepare prerequisites, and guide your installation.'
  cc_environment
  if [ "$cc_verify_only" != yes ]; then
    cc_existing_hint=${cc_root:-$HOME/.campus-commander}
    if [ -z "$cc_profile" ] && [ -z "$cc_answers" ] &&
      [ ! -e "$cc_existing_hint/operator.json" ] && [ ! -e "$cc_existing_hint/setup-pending.json" ]; then cc_select_profile; fi
    # An answers-only profile is resolved after the verified Node download.
    if [ -n "$cc_profile" ]; then cc_host_route; fi
  fi
  cc_prepare_base
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
      --retry 3 --connect-timeout 20 --max-time 600 "$1" --output "$2" ||
      cc_fail 'Download failed. Check internet access, HTTPS certificate trust, and proxy settings, then repeat the installer.'
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
  cc_step '2 / 5  Download and verify the release'
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
  if [ -n "$cc_answers" ]; then
    node -e '
      const fs=require("node:fs");
      const file=process.argv[1],info=fs.lstatSync(file);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>4*1024*1024||fs.realpathSync(file)!==file)throw Error("Use a private regular answers file with mode 600");
      const a=JSON.parse(fs.readFileSync(file));
      if(!a||Array.isArray(a)||typeof a!=="object")throw Error("Answers must contain an object");
      if(a.profile!==undefined&&!["all-docker","hybrid","kubernetes"].includes(a.profile))throw Error("Invalid answers profile");
      if(a.root!==undefined&&(typeof a.root!=="string"||require("node:path").resolve(a.root)!==a.root))throw Error("Use an absolute installation root");
      if(process.argv[3]&&a.profile&&process.argv[3]!==a.profile)throw Error("Profile and answers differ");
      if(process.argv[4]&&a.root&&process.argv[4]!==a.root)throw Error("Installation root and answers differ");
      fs.writeFileSync(process.argv[2],JSON.stringify({profile:a.profile||"",root:a.root||""}));
    ' "$cc_answers" "$cc_stage/answers-routing.json" "$cc_profile" "$cc_root" || cc_fail 'Correct the protected answers file, then repeat the installer.'
    if [ -z "$cc_profile" ]; then cc_profile=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).profile' "$cc_stage/answers-routing.json"); fi
    if [ -z "$cc_root" ]; then cc_root=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).root' "$cc_stage/answers-routing.json"); fi
  fi
  cc_existing=no
  cc_existing_root=${cc_root:-$HOME/.campus-commander}
  node -e '
    const fs=require("node:fs"),path=require("node:path");
    process.on("uncaughtException",e=>{console.error(e.message);process.exitCode=1});
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
    let profile;
    if(file===operator){
      const configInfo=fs.lstatSync(o.configurationPath);
      if(!configInfo.isFile()||configInfo.isSymbolicLink()||(configInfo.mode&0o077)||fs.realpathSync(o.configurationPath)!==o.configurationPath)throw Error("Use private existing configuration");
      profile=JSON.parse(fs.readFileSync(o.configurationPath)).profile;
    }else profile=data.plan?.config?.profile;
    if(!["all-docker","hybrid","kubernetes"].includes(profile))throw Error("Invalid existing profile");
    const releaseKind=manifest.phase===2&&manifest.qualification==="profile-qualified"?"qualified":"candidate";
    fs.writeFileSync(out,JSON.stringify({downloads:path.dirname(o.releaseRoot),tag:"phase-"+(manifest.phase??1)+"-"+releaseKind+"-"+manifest.sourceRevision.slice(0,12),profile}));
  ' "$cc_existing_root" "$cc_stage/existing.json" || cc_fail 'Inspect the existing installation before resuming.'
  cc_saved_downloads=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).downloads||""' "$cc_stage/existing.json")
  if [ -n "$cc_saved_downloads" ]; then
    cc_saved_release=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).tag' "$cc_stage/existing.json")
    [ -z "$cc_release" ] || [ "$cc_release" = "$cc_saved_release" ] || cc_fail 'Use the installed release for resume. Use the documented upgrade procedure to change releases.'
    cc_release=$cc_saved_release
    cc_saved_profile=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).profile' "$cc_stage/existing.json")
    [ -z "$cc_profile" ] || [ "$cc_profile" = "$cc_saved_profile" ] || cc_fail 'Use the existing installation profile when resuming.'
    cc_profile=$cc_saved_profile
    cc_existing=yes
    cc_say "Using the original verified release for $cc_existing_root."
  fi
  if [ -z "$cc_release" ]; then
    cc_download "https://api.github.com/repos/$cc_repo/releases?per_page=100" "$cc_stage/releases.json"
    cc_release=$(node -e '
      const fs=require("node:fs"); const releases=JSON.parse(fs.readFileSync(process.argv[1]));
      if(!Array.isArray(releases))throw Error("Invalid release list");
      const release=releases.filter(r=>!r.draft&&/^phase-([12]-candidate|2-qualified)-[a-f0-9]{12}$/.test(r.tag_name))
        .sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
      if(!release)throw Error("No supported published release exists");
      process.stdout.write(release.tag_name);
    ' "$cc_stage/releases.json") || cc_fail 'Could not select a published release. Retry or provide --release.'
  fi
  case "$cc_release" in
    phase-2-candidate-*)
      cc_candidate=phase-2-candidate
      cc_identity=https://github.com/CampusCommander/campus-commander/.github/workflows/phase-2-candidate.yml@refs/heads/implementation/phase-2-cc-22
      ;;
    phase-2-qualified-*)
      cc_candidate=phase-2-qualified
      cc_identity=https://github.com/CampusCommander/campus-commander/.github/workflows/phase-2-candidate.yml@refs/heads/implementation/phase-2-cc-22
      ;;
    *) cc_candidate=phase-1-candidate ;;
  esac
  cc_say "Downloading $cc_release."
  for cc_asset in "$cc_candidate.tar.gz" "$cc_candidate.sigstore.json" release-manifest.json release-manifest.sigstore.json; do
    if [ "$cc_existing" = yes ]; then
      cp -- "$cc_saved_downloads/$cc_asset" "$cc_stage/$cc_asset" || cc_fail 'The original verified release files are missing.'
    else
      cc_download "https://github.com/$cc_repo/releases/download/$cc_release/$cc_asset" "$cc_stage/$cc_asset" || cc_fail "Download failed for $cc_asset."
    fi
  done
  cc_say 'Verifying the archive and release manifest signatures.'
  cc_verification_log=$(mktemp "$cc_cache/verification.XXXXXXXX.log")
  cosign verify-blob --bundle "$cc_stage/$cc_candidate.sigstore.json" --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_stage/$cc_candidate.tar.gz" > "$cc_verification_log" 2>&1 || cc_fail "Archive signature verification failed. Details: $cc_verification_log"
  cosign verify-blob --bundle "$cc_stage/release-manifest.sigstore.json" --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_stage/release-manifest.json" >> "$cc_verification_log" 2>&1 || cc_fail "Manifest signature verification failed. Details: $cc_verification_log"
  tar -tzf "$cc_stage/$cc_candidate.tar.gz" > "$cc_stage/archive-paths.txt"
  tar -tvzf "$cc_stage/$cc_candidate.tar.gz" > "$cc_stage/archive-types.txt"
  node -e '
    process.on("uncaughtException",error=>{console.error(error.message);process.exitCode=1});
    const fs=require("node:fs");const root=process.argv[1];
    const paths=fs.readFileSync(root+"/archive-paths.txt","utf8").trim().split("\n");
    const seen=new Set();
    for(let path of paths){path=path.replace(/^\.\//,"").replace(/\/$/,""); if(!path)continue;
      if(!/^[A-Za-z0-9_.\/-]+$/.test(path)||path.startsWith("/")||path.split("/").some(p=>!p||p==="."||p==="..")||seen.has(path))throw Error("Unsafe archive path");seen.add(path);}
    for(const line of fs.readFileSync(root+"/archive-types.txt","utf8").trim().split("\n")){if(!["-","d"].includes(line[0]))throw Error("Unsupported archive entry");}
  ' "$cc_stage" || cc_fail 'The archive contains unsafe paths or links.'
  mkdir "$cc_stage/bundle"
  tar --no-same-owner --no-same-permissions -xzf "$cc_stage/$cc_candidate.tar.gz" -C "$cc_stage/bundle"
  node -e '
    process.on("uncaughtException",error=>{console.error(error.message);process.exitCode=1});
    const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
    const root=process.argv[1],tag=process.argv[2],manifestBytes=fs.readFileSync(root+"/release-manifest.json");
    if(!manifestBytes.equals(fs.readFileSync(root+"/bundle/release-manifest.json")))throw Error("Archive and external manifests differ");
    const manifest=JSON.parse(manifestBytes);
    const releaseKind=manifest.phase===2&&manifest.qualification==="profile-qualified"?"qualified":"candidate";
    if(manifest.schemaVersion!==1||!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)||![1,2].includes(manifest.phase??1)||tag!=="phase-"+(manifest.phase??1)+"-"+releaseKind+"-"+manifest.sourceRevision.slice(0,12))throw Error("Release identity differs");
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
    for(const file of ["deployment/installer/setup.mjs","deployment/installer/platforms.mjs","LICENSE.md"]){if(!seen.has(file))throw Error("Release lacks the hosted installer, platform requirements, or license. Select a newer candidate.");}
    const images=[];for(const [key,name] of [["frontend","frontend"],["api","api"],["workers","worker"]]){
      const image=manifest.images?.[key];if(typeof image!=="string"||!new RegExp("^ghcr\\.io/campuscommander/campus-commander-"+name+"@sha256:[a-f0-9]{64}$").test(image))throw Error("Unexpected application image");images.push(image);}
    fs.writeFileSync(root+"/images.txt",images.join("\n")+"\n",{mode:0o600});
  ' "$cc_stage" "$cc_release" || cc_fail 'Release integrity verification failed.'
  if [ "$cc_existing" != yes ] || [ "$cc_verify_only" = yes ]; then
  while IFS= read -r cc_image; do
    cc_status 'Image signature' "${cc_image%@*}"
    cosign verify --certificate-identity "$cc_identity" --certificate-oidc-issuer "$cc_issuer" "$cc_image" >> "$cc_verification_log" 2>&1 || cc_fail "Image signature verification failed. Confirm registry access. Details: $cc_verification_log"
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
  if [ -z "$cc_profile" ]; then cc_select_profile; fi
  case "$cc_profile" in all-docker|hybrid|kubernetes) ;; *) cc_fail 'Select all-docker, hybrid, or kubernetes.' ;; esac
  cc_step '3 / 5  Prepare prerequisites'
  cc_require_package_tool openssl openssl 'OpenSSL is required to prepare HTTPS certificates.'
  if [ "$cc_profile" = hybrid ]; then
    cc_require_package_tool keytool default-jre-headless 'Java keytool is required to prepare hybrid service certificates.'
  fi
  if [ "$cc_profile" = kubernetes ]; then
    if ! command -v kubectl >/dev/null 2>&1; then
      cc_fetch_tool kubectl-v1.35.8 https://dl.k8s.io/release/v1.35.8/bin/linux/amd64/kubectl 874d5e72dbb819f43cff16bcd1e4f8bac5b7f2361fe1e55049b0a6c676fb0cbf
      cp "$cc_cache/kubectl-v1.35.8" "$cc_stage/tools/kubectl"
      chmod 700 "$cc_stage/tools/kubectl"
      PATH="$cc_stage/tools:$PATH"
      export PATH
    fi
    cc_status 'kubectl' 'ready'
    if ! kubectl config current-context >/dev/null 2>&1; then
      cc_say 'A Kubernetes cluster connection is missing.'
      cc_say 'Obtain a kubeconfig from your cluster administrator. Run: export KUBECONFIG=/absolute/path/to/kubeconfig'
      cc_say 'Run: kubectl config get-contexts. Then select the intended context with kubectl config use-context NAME.'
      cc_fail 'Repeat the installer from this shell after configuring cluster access. Select All-Docker if you need local services.'
    fi
    cc_say 'Next, provide your cluster context, namespace, storage classes, HTTPS endpoint, and existing Secret references.'
    cc_say "Preparation guide: $cc_stage/bundle/deployment/kubernetes/README.md"
  else
    cc_prepare_docker
    cc_recover_container_installation
    if [ "$cc_profile" = hybrid ]; then
      cc_say 'Next, provide your external PostgreSQL and Redis endpoints, protected credentials, certificates, shared storage, and worker addresses.'
      cc_say 'The installer will create configuration and print the deployment commands for each worker host.'
      cc_say "Preparation guide: $cc_stage/bundle/deployment/profiles/hybrid/README.md"
    fi
  fi
  cc_step '4 / 5  Configure your installation'
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
