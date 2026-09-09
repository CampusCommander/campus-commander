# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS build
ARG SOURCE_DATE_EPOCH=0
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY nx.json tsconfig.base.json eslint.config.mjs ./
COPY frontend ./frontend
RUN npm exec -- nx run frontend:build
RUN find /workspace/dist/frontend -exec touch -d "@${SOURCE_DATE_EPOCH}" {} +

FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=node:node deployment/images/frontend-server.mjs ./server.mjs
COPY --from=build --chown=node:node /workspace/dist/frontend/browser ./browser
COPY --chown=node:node LICENSE.md ./LICENSE.md
LABEL org.opencontainers.image.licenses="LicenseRef-Campus-Commander-Community-1.0.0"
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "const fs=require('node:fs'),https=require('node:https');const tls=process.env.TLS_CERT_FILE;if(!tls){fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1));}else{https.get({hostname:'127.0.0.1',port:8080,path:'/health',servername:process.env.TLS_SERVER_NAME,ca:fs.readFileSync(process.env.TLS_CA_FILE||tls)},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1));}"]
CMD ["node", "server.mjs"]
