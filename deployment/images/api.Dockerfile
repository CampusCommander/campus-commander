# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS build
ARG SOURCE_DATE_EPOCH=0
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY nx.json tsconfig.base.json eslint.config.mjs ./
COPY api ./api
COPY libs/application-contracts ./libs/application-contracts
COPY deployment ./deployment
RUN npm exec -- nx run deployment:build
RUN npm exec -- nx run api:build
RUN find /workspace/dist/api /workspace/dist/deployment -exec touch -d "@${SOURCE_DATE_EPOCH}" {} +

FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS runtime-dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995
ENV NODE_ENV=production PORT=3000
ARG CC_VERSION=development
ARG CC_BUILD_ID=unreleased
ENV CC_VERSION=${CC_VERSION} CC_BUILD_ID=${CC_BUILD_ID}
LABEL org.opencontainers.image.version=${CC_VERSION} org.opencontainers.image.revision=${CC_BUILD_ID}
RUN apk add --no-cache libcrypto3=3.5.8-r0 libssl3=3.5.8-r0 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build --chown=node:node /workspace/dist/api ./
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/deployment/bootstrap/access.mjs /workspace/deployment/bootstrap/api-runtime.mjs /workspace/deployment/bootstrap/cli.mjs /workspace/deployment/bootstrap/edge.mjs /workspace/deployment/bootstrap/main.mjs /workspace/deployment/bootstrap/status.mjs ./deployment/bootstrap/
COPY --from=build --chown=node:node /workspace/deployment/bootstrap/application-edge.mjs ./deployment/bootstrap/
COPY --from=build --chown=node:node /workspace/deployment/bootstrap/application-access.mjs /workspace/deployment/bootstrap/application-access-cli.mjs ./deployment/bootstrap/
COPY --from=build --chown=node:node /workspace/deployment/kestra/render-config.mjs ./deployment/kestra/
COPY --from=build --chown=node:node /workspace/deployment/kestra/phase2-connection.yaml ./deployment/kestra/
COPY --from=build --chown=node:node /workspace/deployment/postgres/index.mjs /workspace/deployment/postgres/cli.mjs /workspace/deployment/postgres/secrets.mjs ./deployment/postgres/
COPY --from=build --chown=node:node /workspace/deployment/postgres/migrations ./deployment/postgres/migrations
COPY --from=build --chown=node:node /workspace/deployment/redis/runtime.mjs /workspace/deployment/redis/probe.mjs ./deployment/redis/
COPY --from=build --chown=node:node /workspace/deployment/storage/index.mjs ./deployment/storage/
COPY --from=build --chown=node:node /workspace/dist/deployment ./dist/deployment
COPY --chown=node:node LICENSE.md ./LICENSE.md
LABEL org.opencontainers.image.licenses="LicenseRef-Campus-Commander-Community-1.0.0"
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "const fs=require('node:fs'),https=require('node:https');const tls=process.env.TLS_CERT_FILE;if(!tls){fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1));}else{https.get({hostname:'127.0.0.1',port:3000,path:'/health',servername:process.env.TLS_SERVER_NAME,ca:fs.readFileSync(process.env.TLS_CA_FILE||tls)},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1));}"]
CMD ["node", "main.js"]
