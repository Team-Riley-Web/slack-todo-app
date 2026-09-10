/** @type {import('next').NextConfig} */
const nextConfig = {
  // The App Router transpiles workspace packages automatically, so this is
  // declared for explicitness rather than necessity — it makes the dependency
  // on raw-TypeScript workspace packages visible to anyone reading the config.
  transpilePackages: ['@tr/db', '@tr/task-core', '@tr/slack-ui', '@tr/slack-sync', '@tr/importer'],
  eslint: { ignoreDuringBuilds: true },

  /**
   * Native and WASM packages must be loaded by Node, not bundled.
   *
   * PGlite ships WebAssembly; bundling it produces an opaque
   * "path argument must be of type string" failure on every request, because
   * the bundler picks a build whose filesystem shim does not match Node's.
   * pg is listed for the same reason — it has optional native bindings.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],

  webpack(config) {
    /**
     * Our packages use the NodeNext convention of importing `./thing.js` from
     * `./thing.ts`. Node and vitest resolve that; webpack does not without
     * being told, and the failure is a confusing "can't resolve ./errors.js".
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
