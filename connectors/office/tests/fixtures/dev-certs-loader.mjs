import { register } from 'node:module';

const defaults = new URL('./dev-certs-defaults-stub.mjs', import.meta.url).href;
const stub = new URL('./dev-certs-stub.mjs', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'office-addin-dev-certs/lib/defaults.js') return { url: ${JSON.stringify(defaults)}, shortCircuit: true };
    if (specifier === 'office-addin-dev-certs') {
      return { url: ${JSON.stringify(stub)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
