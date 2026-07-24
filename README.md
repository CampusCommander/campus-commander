# Campus Commander

A self-hosted, single-tenant web application for Google Workspace administrators (K-12 school districts) to manage Workspace assets in bulk — replacing the slow/limited bulk workflows in Google's own Admin Console.

## Tech Stack

- **Frontend:** Angular 20 (NgRx Signals + Angular Material + Tailwind CSS)
- **Backend:** NestJS (TypeScript)
- **Orchestration:** Kestra (Declarative YAML Flows)
- **Database:** Postgres (Entity Cache)
- **Cache:** Redis (NestJS caching + pub/sub)
- **Monorepo:** Nx
- **Deployment:** Docker Compose

## Project Structure

```
campus-commander/
├── apps/
│   ├── frontend/          # Angular 20 (Material + Tailwind)
│   ├── frontend-e2e/      # End-to-end tests
│   ├── api/               # NestJS (Auth, RBAC, Internal Job Endpoints)
│   └── api-e2e/           # End-to-end tests
├── libs/
│   ├── shared/            # TS interfaces, DTOs, entity schemas
│   └── kestra/            # YAML flow definitions (deployed to Kestra volume)
├── docs/                  # Design specs and research
└── docker-compose.yml     # Full deployment stack
```

## Development

```bash
# Start development servers
npx nx serve frontend
npx nx serve api

# Build all projects
npx nx run-many --target=build

# Run tests
npx nx test frontend
npx nx test api
```

## Deployment

```bash
docker compose up -d
```

## Documentation

- [Core Entity Management Design](docs/superpowers/specs/2026-07-07-core-entity-management-design.md)
- [Architecture Overview](docs/architecture/2026-07-22-campus-commander-architecture.md)
- [Google API Quotas](docs/research/google-api-quotas.md)

## License

MIT
