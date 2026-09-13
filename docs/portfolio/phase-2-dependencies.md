# Phase 2 dependency qualification

Status: runtime qualification remains in progress under CC-37.

The September 12, 2026 production audit reports zero known vulnerabilities.
The complete development dependency audit reports six moderate findings and no high or critical findings.
These results describe the current npm lockfile. They do not establish image or release acceptance.

| Dependency                         | Qualified candidate | Reason                                                        |
| ---------------------------------- | ------------------- | ------------------------------------------------------------- |
| Angular framework                  | 22.1.6              | Security fixes and aligned framework peers                    |
| Angular CLI, build, and schematics | 22.1.8              | Compatible Angular 22.1 tooling                               |
| Angular Material and CDK           | 22.1.6              | Shared controls and aligned Angular peers                     |
| NgRx Signals                       | 22.0.0              | Application session and preference state                      |
| openid-client                      | 6.8.8               | OIDC authorization code validation                            |
| Redis client                       | 5.11.0              | Shared sessions and bounded diagnostic reservations           |
| Axios                              | 1.20.0              | Published security fixes                                      |
| Multer override                    | 2.3.0               | Replace the vulnerable Nest transitive version                |
| qs override                        | 6.16.0              | Replace the vulnerable Express transitive version             |
| Nx and official Nx plugins         | 23.2.1              | Align plugins and remove the vulnerable image-size dependency |
| Vitest, UI, and coverage           | 4.1.11              | Replace vulnerable test server packages                       |
| axe Playwright integration         | 4.13.0              | Browser accessibility evidence                                |
| brace-expansion override           | 5.0.9               | Bound expansion against denial of service                     |
| smol-toml override                 | 1.8.0               | Replace vulnerable Nx configuration parsing                   |

The Multer and qs overrides retain their existing major versions.
Phase 2 exposes fixed JSON application requests. It exposes no multipart-upload endpoint.
The runtime override still requires API and deployment regression checks.
The Axios override also replaces the vulnerable Nx transitive version.
Nx generated four migrations. All four ran successfully without source changes.

## Remaining development advisory

All six remaining findings trace to UUID through SockJS and the webpack development server.
The advisory affects UUID v3, v5, and v6 calls with caller-provided buffers.
The installed SockJS transport calls only `require('uuid').v4()` without arguments.
Production images omit SockJS and the webpack development server.
This review records the remaining advisory. It does not suppress the audit result.
Keep development listeners restricted to the development environment.
Recheck the dependency chain before each release.

Source: [UUID bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

The Zod namespace import removes unused locale bundles from frontend output.
The Angular 22.1.6 production build totals approximately 377 kB before compression.
The existing initial-bundle warning budget remains 500 kB.

Run these checks against the release candidate lockfile:

```sh
npm audit --omit=dev
npx nx run-many -t lint,test -p api,frontend,application-contracts,deployment,worker
npx nx run api-e2e:auth-integration
```

References: [Angular security advisory](https://github.com/advisories/GHSA-hh8m-fm6v-7cvg), [Multer 2.3.0](https://github.com/expressjs/multer/releases/tag/v2.3.0), [Axios 1.20.0](https://github.com/axios/axios/releases/tag/v1.20.0), and [Zod imports](https://zod.dev/error-customization).
