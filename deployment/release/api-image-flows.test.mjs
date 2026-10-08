import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the API image contains every Kestra flow the API deploys', async () => {
  const service = await readFile(
    'api/src/app/orchestration/orchestration.service.ts',
    'utf8',
  );
  const dockerfile = await readFile('deployment/images/api.Dockerfile', 'utf8');
  const flows = [...service.matchAll(/deployFlow\(\s*'([\w.-]+\.yaml)'/g)].map(
    (match) => match[1],
  );
  assert.ok(flows.length >= 2, 'The orchestration service deploys flows.');
  for (const flow of flows)
    assert.match(
      dockerfile,
      new RegExp(
        `COPY [^\\n]*/workspace/deployment/kestra/${flow.replace('.', '\\.')}[^\\n]* \\./deployment/kestra/`,
      ),
      `${flow} is missing from deployment/images/api.Dockerfile`,
    );
});
