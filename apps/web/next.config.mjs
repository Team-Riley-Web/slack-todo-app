/** @type {import('next').NextConfig} */
const nextConfig = {
  // The App Router transpiles workspace packages automatically, so this is
  // declared for explicitness rather than necessity — it makes the dependency
  // on raw-TypeScript workspace packages visible to anyone reading the config.
  transpilePackages: ['@tr/db', '@tr/task-core', '@tr/slack-ui', '@tr/slack-sync', '@tr/importer'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
