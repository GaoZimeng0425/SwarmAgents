const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

// Monorepo support: watch the repo root (so packages/protocol/src changes
// rebuild), and let metro follow pnpm's symlinks (unstable_enableSymlinks)
// instead of forcing node-linker=hoisted (which would affect the whole repo).
const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [monorepoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]
config.resolver.unstable_enableSymlinks = true
config.resolver.unstable_enablePackageExports = true
config.resolver.extraNodeModules = {
  '@swarm/protocol': path.resolve(monorepoRoot, 'packages/protocol/src'),
}

module.exports = config
