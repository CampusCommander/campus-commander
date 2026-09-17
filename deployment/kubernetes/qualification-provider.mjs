/** Add synthetic transport only to the isolated qualification workloads. */
export function configureKubernetesProvider(resources, application) {
  for (const name of application.phase === 3 ? ['api', 'workers'] : ['api']) {
    const pod = resources.items.find(
      (item) => item.kind === 'Deployment' && item.metadata.name === name,
    ).spec.template.spec;
    pod.hostAliases = [
      { ip: application.hostGateway, hostnames: ['host.docker.internal'] },
    ];
    pod.volumes.push({
      name: 'qualification-provider',
      secret: { secretName: 'qualification-provider' },
    });
    const container = pod.containers.find((item) => item.name === name);
    container.env.push({
      name: 'NODE_EXTRA_CA_CERTS',
      value: '/run/qualification/ca',
    });
    if (application.phase === 3)
      container.env.push({
        name: 'NODE_OPTIONS',
        value: '--require=/run/qualification/google-connection-preload.cjs',
      });
    container.volumeMounts.push({
      name: 'qualification-provider',
      mountPath: '/run/qualification',
      readOnly: true,
    });
  }
}
