#!/bin/bash
set -e

CERT_DIR="./certs"
HOSTNAME="${1:-test-env.local}"

mkdir -p "$CERT_DIR"

echo "=== Generating self-signed certificate for $HOSTNAME ==="

# Generate private key
openssl genrsa -out "$CERT_DIR/private.key" 2048

# Generate certificate signing request
openssl req -new \
  -key "$CERT_DIR/private.key" \
  -out "$CERT_DIR/certificate.csr" \
  -subj "/C=US/ST=Test/L=TestCity/O=TestOrg/CN=$HOSTNAME"

# Generate self-signed certificate (valid for 365 days)
openssl x509 -req \
  -days 365 \
  -in "$CERT_DIR/certificate.csr" \
  -signkey "$CERT_DIR/private.key" \
  -out "$CERT_DIR/certificate.crt" \
  -extfile <(printf "subjectAltName=DNS:$HOSTNAME,DNS:*.local")

echo "=== Certificate generated ==="
echo "Certificate path: $CERT_DIR/certificate.crt"
echo "Private key path: $CERT_DIR/private.key"
echo "Hostname: $HOSTNAME"

ls -la "$CERT_DIR"
