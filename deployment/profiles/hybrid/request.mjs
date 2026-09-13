import https from 'node:https';

export function request({
  port,
  servername,
  ca,
  authorization,
  method = 'GET',
  path,
  body,
  contentType,
  timeoutMilliseconds = 5000,
}) {
  return new Promise((resolve, reject) => {
    const client = https.request(
      {
        agent: false,
        hostname: '127.0.0.1',
        port,
        servername,
        method,
        path,
        ca,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        timeout: timeoutMilliseconds,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    client.on('timeout', () => client.destroy(new Error('request timeout')));
    client.on('error', reject);
    if (body) client.write(body);
    client.end();
  });
}
