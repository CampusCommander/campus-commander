ARG APPLICATION_IMAGE
FROM ${APPLICATION_IMAGE} AS application
FROM docker@sha256:5efed980cba3fc126cf54e21a5a6ff8849d05b6e0623d6e7612f48e9cd6cd17e
RUN apk add --no-cache libstdc++ openjdk21-jre-headless openssl
COPY --from=application /usr/local/bin/node /usr/local/bin/node
RUN node --version && keytool -help >/dev/null
ENTRYPOINT ["/usr/local/bin/dind", "dockerd"]
CMD ["--host=unix:///var/run/docker.sock"]
