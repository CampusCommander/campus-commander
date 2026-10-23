// CI uploads failure evidence even when a step throws, so the run-time record
// must not carry an authentication value. Redaction keeps the origin, the
// path, and the parameter names, and drops every value.
import { registeredEvidenceValues } from './evidence-security.mjs';

/** Match the value of a parameter in a query string or a fragment. */
const parameterValues = /([?&#][A-Za-z0-9_.~\-[\]]+)=([^&\s"'<>#]*)/g;

/**
 * Replace every registered protected value, whatever its length and whatever
 * text surrounds it. Each value is replaced as it stands, so a bare console
 * value needs no parameter name. The longest value goes first, so a value
 * that contains another value cannot leave a suffix behind.
 */
const redactKnownValues = (value, knownValues) => {
  const longestFirst = [
    ...new Set([...registeredEvidenceValues(), ...knownValues]),
  ]
    .filter((known) => typeof known === 'string' && known.length > 0)
    .sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const known of longestFirst)
    redacted = redacted.split(known).join('redacted');
  return redacted;
};

/** Replace the value of every parameter of a URL-shaped text. */
const redactParameterValues = (value) =>
  value.replace(parameterValues, '$1=redacted');

/** Redact a URL that `URL` cannot parse, such as a relative callback path. */
const redactRelativeUrl = (value) => {
  const [address, ...fragments] = value.split('#');
  const fragment = fragments.length ? '#redacted' : '';
  return `${redactParameterValues(address)}${fragment}`;
};

/**
 * Redact the credentials, the query values, and the fragment of a URL. The
 * scheme, the host, the port, the path, and the query names stay, so the
 * record still names the page that failed. The optional `knownValues` are
 * registered credentials, which are replaced whatever their position.
 */
export function redactUrl(value, knownValues = []) {
  if (typeof value !== 'string') return '';
  const text = redactKnownValues(value, knownValues);
  let url;
  try {
    url = new URL(text);
  } catch {
    return redactRelativeUrl(text);
  }
  // Build the URL from its parts. The user information is never read, so a
  // credential in it cannot reach the record.
  const authority = url.host
    ? `${url.protocol}//${url.host}`
    : url.protocol === 'file:'
      ? `${url.protocol}//`
      : url.protocol;
  const query = [...url.searchParams.keys()]
    .map((key) => `${encodeURIComponent(key)}=redacted`)
    .join('&');
  const search = query ? `?${query}` : '';
  const fragment = url.hash ? '#redacted' : '';
  return `${authority}${url.pathname}${search}${fragment}`;
}

// A console message repeats the URLs of the page, and it can carry a token
// with no parameter name. Each pattern below names a value that is a
// credential in every context.
const absoluteUrl = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const jwtValue =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const opaqueValue = /\b[A-Za-z0-9_-]{40,}\b/g;

/**
 * Redact the credentials of a console message before the record truncates it.
 * Registered `knownValues` go first, so a value of any length and with any
 * delimiter around it is removed. Truncation follows redaction, so a cut
 * cannot keep part of a value. The optional `limit` bounds the redacted text.
 */
export function redactText(value, limit = Infinity, knownValues = []) {
  if (typeof value !== 'string') return '';
  const redacted = redactKnownValues(value, knownValues)
    .replace(absoluteUrl, (url) => redactUrl(url))
    .replace(bearerValue, 'Bearer redacted')
    .replace(jwtValue, 'redacted')
    .replace(opaqueValue, 'redacted')
    .replace(parameterValues, '$1=redacted');
  return redacted.slice(0, limit);
}
