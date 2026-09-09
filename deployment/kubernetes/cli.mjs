import { readFile, writeFile } from 'node:fs/promises';
import { renderKubernetes } from './render.mjs';

try {
  const [profilePath, operatorPath, outputPath] = process.argv.slice(2);
  if (!profilePath || !operatorPath || !outputPath)
    throw new Error('Provide profile, operator input, and output paths.');
  const rendered = renderKubernetes(
    JSON.parse(await readFile(profilePath, 'utf8')),
    JSON.parse(await readFile(operatorPath, 'utf8')),
  );
  await writeFile(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    'Kubernetes resources rendered. Cluster qualification remains separate.',
  );
} catch {
  console.error(
    'Kubernetes rendering failed. Check profile, release inventory, namespace, secrets, storage, and network prerequisites.',
  );
  process.exitCode = 1;
}
