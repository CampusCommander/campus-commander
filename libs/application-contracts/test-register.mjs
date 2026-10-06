import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@campus/application-contracts') {
      return nextResolve(
        new URL('./src/index.ts', import.meta.url).href,
        context,
      );
    }
    if (specifier === '@campus/google-connection') {
      return nextResolve(
        new URL('../google-connection/src/index.ts', import.meta.url).href,
        context,
      );
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        (context.parentURL?.includes('/libs/') ||
          context.parentURL?.includes('/worker/src/'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
