# Run the Admin SDK mock

The Admin SDK mock is a local stand-in for the Google Admin SDK Directory API and the Chrome Management telemetry API.
It seeds K-12 domains for scale and quota testing, from an empty domain to the 400,000-device `xlarge` tier.
The mock is test infrastructure. It never serves production traffic, and it never holds a real Google credential.

The [mock repository](https://github.com/CampusCommander/admin-sdk-mock) holds the guides and the generated reference pages.
The installed package carries the same `README.md`, `CHANGELOG.md`, and `schema/config.schema.json`.
The [client review runbook](client-review.md#review-against-admin-sdk-mock) describes the review environment that runs against this mock.

## The pinned tarball

The root `package.json` pins the release tarball in `devDependencies`:

```text
https://github.com/CampusCommander/admin-sdk-mock/releases/download/v0.2.0/campuscommander-admin-sdk-mock-0.2.0.tgz
```

The `package-lock.json` records that URL, the version `0.2.0`, and this sha512 integrity hash:

```text
sha512-zwUl0MR5ludnJYq7CwqlhnepRvGDT62UMJR87jertYhkDEhNj+RaLlATfjlqmGBtNmZFDYD4Kqh748EkiBnEPQ==
```

The package needs Node 24.11 or later. CI pins Node 24.19.0.

Version 0.2.0 adds the seed specification field `primaryDomain`.
The mock serves the given domain as the primary domain and derives the student and alias domains under it.
A specification without `primaryDomain` keeps the 0.1.0 seed data byte for byte.

The release tarball holds the built `dist/` and `schema/` directories.
It declares one lifecycle script, `prepare`. npm skips `prepare` for a tarball install, so no build runs here.
The `allowScripts` field in `package.json` needs no entry for the mock. `npm ci` installs the tarball and runs no script.

A Git dependency needs `git` and builds the package during install. The image build stages have neither.
`deployment/images/api.Dockerfile`, `frontend.Dockerfile`, and `worker.Dockerfile` run `npm ci` inside `node:24.19.0-alpine3.23`.
That image has no `git`. The tarball keeps the three image builds working without a package build step.

The mock is a `devDependency`. The runtime stages install with `npm ci --omit=dev`, so the mock never enters a runtime image.

## Start and stop

Run the mock from the repository root:

```sh
npm exec -- admin-sdk-mock start
```

`start` reads `admin-sdk-mock.json` in the working directory. It logs one JSON line per event to standard output.
The `ready` line names the customer ID, every listener, and the service-account key file.
`npm exec -- admin-sdk-mock doctor` checks Node, the configuration, the data directory, the CA file, and the ports.

Stop the mock with Ctrl+C or `SIGTERM`. A graceful stop closes every listener.

## Failure behavior

The review harness watches the mock container after its ready signal.
A stopped mock fails the run. The harness prints the container log and exits nonzero.
The harness never falls back to the in-process simulator.

The watch holds for the whole run, not only for startup:

- During startup, a mock exit stops the startup sequence. The harness prints the container log within five seconds of the exit. It prints no ready banner and starts no later container.
- During the integration flow, every failure path reads the watch before the teardown. The container log reaches the output whatever request failed first.
- During an interactive review, the run ends with the container log and a nonzero exit code.
- The harness removes its containers, its network, and its temporary run directory in each case.

The fixture checks cover the startup failure and the ready-then-exit case against a real container:

```sh
npm exec -- nx run api-e2e:admin-sdk-mock-fixture-test
```

The exit checks cover a mock exit during startup and during an in-flight integration request.
Each check runs the review harness as its own process and stops the owned container at that moment:

```sh
npm exec -- nx run api-e2e:admin-sdk-mock-exit-test
```

`api-e2e/admin-sdk-mock-fault-hook.mjs` stops the container during the in-flight check. The harness source holds no fault-injection code.
The exit checks start two review environments, so they need Docker and about five minutes.

A startup failure prints the mock CLI error, because the log reader keeps stdout and stderr.

## Configuration

The committed `admin-sdk-mock.json` at the repository root holds these settings:

| Setting          | Value                                                                            | Reason                                                          |
| ---------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Domain           | `medium`, seed `campus-commander-dev`                                            | The seed decides the customer ID and the district name.         |
| District name    | `Easton Consulting`                                                              | The name every mock run presents.                               |
| Primary domain   | `easton-consulting.com`                                                          | The mock derives the child domains under this domain.           |
| Service account  | `read-write`, key file `./.admin-sdk-mock/credentials/campus-commander-dev.json` | The key file carries mode 0600.                                 |
| Data directory   | `./.admin-sdk-mock/data`                                                         | Disposable. Delete it to seed again.                            |
| Control listener | `127.0.0.1:18080`                                                                | Port 8080 is often taken on a developer machine.                |
| Proxy            | `127.0.0.1:3128`                                                                 | The client reaches the mock through this port.                  |
| Google listener  | `127.0.0.1:8443`                                                                 | The default. The proxy tunnels the four Google hostnames to it. |

The seed `campus-commander-dev` always yields the customer ID `C0cmfin9i` and the district `Easton Consulting` on `easton-consulting.com`.
The mock derives `k12.easton-consulting.com` as an alias domain, and `students.easton-consulting.com` when the seed picks a separate student domain.
The administrator `admin@easton-consulting.com` is the delegated subject for the service account.

`.gitignore` excludes `/.admin-sdk-mock/`. The folder holds generated key files and disposable domain data.

Validate the file after an edit:

```sh
npm exec -- admin-sdk-mock config validate admin-sdk-mock.json
```

## Client environment

Load the client environment into the shell that runs the client under test:

```sh
eval "$(npm exec -- admin-sdk-mock env)"
```

The command exports the proxy, the `NO_PROXY` list, the CA paths, and `ADMIN_SDK_MOCK_CONTROL`.
It also exports `GOOGLE_APPLICATION_CREDENTIALS`, because the configuration holds one service account.

The proxy variables route every later HTTPS call of that shell through the mock proxy.
Open a new shell for unrelated work, such as a `docker build` or a package download.

Mint a token and call the Directory API:

```sh
TOKEN="$(npm exec -- admin-sdk-mock token C0cmfin9i --raw)"
curl -H "Authorization: Bearer $TOKEN" "https://admin.googleapis.com/admin/directory/v1/customer/my_customer/devices/chromeos?maxResults=5"
```

The call answers HTTP 200 with five devices. Every Google call in this workflow goes to the mock.

## Upgrade

1. Read the mock `CHANGELOG.md` for the new tag. Any 0.x release can change the configuration, the CLI, or the API.
2. Change the tag in the tarball URL in the root `package.json`.
3. Run `npm install`.
4. Commit `package.json`, `package-lock.json`, and this file.
5. Delete `.admin-sdk-mock/` when the specification changed, for example a new district name or primary domain.
   The mock keeps the existing data and refuses a changed specification.
   The next start seeds the new specification into the empty directory.
6. Run the validation, the start command, and the Directory API call above against the new version.

## The mock tenant and the real tenant

The mock tenant uses the domain `easton-consulting.com` with mock customer IDs.
Review, integration, and standalone runs reach only the local mock.
The real Easton tenant is customer `C01zcarnq`.
Only the read-only live checks in `AGENTS.md` use the real tenant.
Never upload a real credential to a mock review environment.

## License

The mock ships under the PolyForm Noncommercial License 1.0.0.
It is test infrastructure only. Do not ship the package or its code in a product or a runtime image.

## Verified on 2026-10-15

The install ran on Node 24.19.0 and npm 11.19.1. `npm ci` installed 1,504 packages from a removed `node_modules`.
The lockfile change added `node_modules/@campuscommander/admin-sdk-mock` and `node_modules/node-forge` 1.4.0, and nothing else.
`npm exec -- admin-sdk-mock --help` exited 0 from the installed package.

`start` reached ready with the control listener on 18080 and the proxy on 3128.
`env` and `token` produced a bearer token, and the devices call returned HTTP 200 with five devices.
`ss -ltnp` showed no listener on 18080 or 3128 after the stop.

The three image builds passed with `npm exec nx run-many -- -t image -p api,frontend,worker --parallel=1`.
The runtime image held no mock package. A `npm ci` probe inside `node:24.19.0-alpine3.23` installed the mock with no `git` present.

## Verified on 2026-10-16

The 0.2.0 pin installed with `npm ci` on Node 24.19.0 and npm 11.19.1.
The lockfile entry holds the tarball URL, the version `0.2.0`, and the integrity hash above.
`npm exec -- admin-sdk-mock config validate admin-sdk-mock.json` printed `admin-sdk-mock.json is valid.`

The standalone `start` reported the customer `C0cmfin9i`, the primary domain `easton-consulting.com`, and the administrator `admin@easton-consulting.com`.
The `medium` tier served 180 organizational units, 6,703 users, 7,000 devices, and 1,161 groups.
A `SIGTERM` closed every listener. Ports 8443, 18080, and 3128 were free after the stop.

## Scale observation

The `large` tier serves 60,000 devices. The integration flow ran against it on 2026-10-15 on Node 24.19.0 with modeled latency on.
The run finished and published every device. It wrote `dist/client-review/admin-sdk-mock-run.json`.

| Value                              | Observation                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Devices shown                      | 60,000, which equals the device count of the mock domain                                             |
| Full sync duration                 | 493.6 seconds, which is 122 devices per second                                                       |
| Mock quota counters after the sync | `directory` 0, `chrome` 38, and the control `chrome` bucket 1, each with a limit of 3000 and no flag |

The sync read the inventory and the telemetry of 60,000 devices in about eight minutes.
The working tree held no leftover container and no leftover run directory after the run.
Only one device battery class is compared per run, so the record does not describe every device.

The rate of 122 devices per second comes from the modeled latency, which applies 150 ms per call and 3 ms per item.
A domain of 400,000 devices (`xlarge`) needs about one hour at that rate.
Run the tiers above `medium` on a dedicated machine, and keep the full sync out of the default CI path.
