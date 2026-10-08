import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';

// The isolated DNS fixture maps district names and forwards other questions.
const server = dgram.createSocket('udp4');
server.on('message', async (message, client) => {
  if (
    message.length < 12 ||
    message.length > 4096 ||
    message.readUInt16BE(4) !== 1
  )
    return;
  try {
    let offset = 12;
    const labels = [];
    while (message[offset]) {
      const length = message[offset++];
      if (length > 63 || offset + length >= message.length) return;
      labels.push(message.subarray(offset, offset + length).toString('ascii'));
      offset += length;
    }
    offset++;
    if (offset + 4 > message.length) return;
    const type = message.readUInt16BE(offset);
    const hosts = JSON.parse(await readFile('/fixture/hosts.json', 'utf8'));
    const addresses = hosts[labels.join('.').toLowerCase()];
    if (addresses) {
      const answers = type === 1 ? addresses : [];
      const header = Buffer.from(message.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(answers.length, 6);
      header.writeUInt32BE(0, 8);
      const records = answers.map((address) => {
        const record = Buffer.alloc(16);
        record.writeUInt16BE(0xc00c, 0);
        record.writeUInt16BE(1, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(1, 6);
        record.writeUInt16BE(4, 10);
        Buffer.from(address.split('.').map(Number)).copy(record, 12);
        return record;
      });
      server.send(
        Buffer.concat([header, message.subarray(12, offset + 4), ...records]),
        client.port,
        client.address,
      );
      return;
    }
    const upstream = dgram.createSocket('udp4');
    const timer = setTimeout(() => upstream.close(), 3000);
    upstream.once('error', () => {
      clearTimeout(timer);
      upstream.close();
    });
    upstream.once('message', (answer) => {
      clearTimeout(timer);
      server.send(answer, client.port, client.address);
      upstream.close();
    });
    upstream.send(message, 53, '127.0.0.11');
  } catch {
    // Malformed fixture questions receive no response.
  }
});
server.bind(53, '0.0.0.0');
