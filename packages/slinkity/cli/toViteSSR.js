const { createServer, build, defineConfig, mergeConfig } = require('vite')
const path = require('path')
const requireFromString = require('require-from-string')
const logger = require('../utils/logger')
const { getSharedConfig } = require('./vite')
const { toBuilder } = require('./toBuilder')

/**
 * Regex of hard-coded stylesheet extensions
 * TODO: generate regex from applied Vite plugins
 * @param {string} imp Import to test
 * @returns Whether this import ends with an expected CSS file extension
 */
function isStyleImport(imp) {
  return /\.(css|scss|sass|less|stylus)($|\?*)/.test(imp)
}

module.exports.isStyleImport = isStyleImport

/**
 * Recursively walks through all nested imports for a given module,
 * Searching for any CSS imported via ESM
 * @param {import('vite').ModuleNode | undefined} mod The module node to collect CSS from
 * @param {Set<string>} collectedCSSModUrls All CSS imports found
 * @param {Set<string>} visitedModUrls All modules recursively crawled
 */
function collectCSS(mod, collectedCSSModUrls, visitedModUrls = new Set()) {
  if (!mod || !mod.url || visitedModUrls.has(mod.url)) return

  visitedModUrls.add(mod.url)
  if (isStyleImport(mod.url)) {
    collectedCSSModUrls.add(mod.url)
  } else {
    mod.importedModules.forEach((subMod) => {
      collectCSS(subMod, collectedCSSModUrls, visitedModUrls)
    })
  }
}

module.exports.collectCSS = collectCSS

/**
 * Production-style build using Vite's build CLI
 * @typedef ViteBuildParams
 * @property {import('vite').UserConfigExport} ssrViteConfig
 * @property {string} filePath
 * @property {import('../@types').Environment} environment
 * @param {ViteBuildParams}
 * @returns {DefaultModule}
 */
async function viteBuild({ ssrViteConfig, filePath, environment }) {
  const isNpmPackage = /^[^./]|^\.[^./]|^\.\.[^/]/
  const input = isNpmPackage.test(filePath) ? path.resolve('node_modules', filePath) : filePath
  const { output } = await build({
    ...ssrViteConfig,
    mode: environment,
    build: {
      ssr: true,
      write: false,
      rollupOptions: {
        input,
      },
    },
  })
  /** @type {DefaultModule} */
  const defaultMod = {
    default: () => null,
    __importedStyles: new Set(),
  }
  if (!output?.length) {
    logger.log({
      type: 'error',
      message: `Module ${filePath} didn't have any output. Is this file blank?`,
    })
    return defaultMod
  }
  const __importedStyles = new Set(Object.keys(output[0].modules ?? {}).filter(isStyleImport))
  return {
    ...defaultMod,
    __importedStyles,
    // converts our stringified JS to a CommonJS module in memory
    // saves reading / writing to disk!
    // TODO: check performance impact
    ...requireFromString(output[0].code),
  }
}

/**
 * @typedef ToViteConfigParams
 * @property {import('../@types').Dir} dir
 * @property {import('../@types').UserSlinkityConfig} userSlinkityConfig
 * @param {ToViteConfigParams} params
 * @returns {import('vite').UserConfigExport}
 */
async function toViteConfig({ dir, userSlinkityConfig }) {
  const sharedConfig = await getSharedConfig({ dir, userSlinkityConfig })
  return defineConfig(mergeConfig({ root: dir.output }, sharedConfig))
}

/**
 * @typedef ViteSSRParams
 * @property {import('../@types').Environment} environment
 * @property {import('../@types').Dir} dir
 * @property {import('../@types').UserSlinkityConfig} userSlinkityConfig
 * @param {ViteSSRParams}
 *
 * @typedef DefaultModule
 * @property {() => any} default
 * @property {Set<string>} __importedStyles
 *
 * @typedef {import('../@types').ViteSSR} ViteSSR
 *
 * @returns {ViteSSR} viteSSR
 */
function toViteSSR({ environment, dir, userSlinkityConfig }) {
  if (environment === 'development') {
    /** @type {import('vite').ViteDevServer} */
    let server = null
    const builder = toBuilder(async function buildModule(filePath) {
      if (!server) {
        throw new Error(
          `Attempted to build "${filePath}" before Vite was started! If you're using Slinkity as a plugin, check that you're using 11ty v2.0 or later.`,
        )
      }

      const ssrModule = await server.ssrLoadModule(filePath)
      const moduleGraph = await server.moduleGraph.getModuleByUrl(filePath)
      /** @type {Set<string>} */
      const __importedStyles = new Set()
      collectCSS(moduleGraph, __importedStyles)

      /** @type {DefaultModule} */
      const viteOutput = {
        default: () => null,
        __importedStyles,
        ...ssrModule,
      }
      return viteOutput
    })
    return {
      async toCommonJSModule(filePath) {
        return builder.build(filePath, null, { shouldUseCache: false })
      },
      getServer() {
        return server
      },
      async createServer() {
        const ssrViteConfig = await toViteConfig({ dir, userSlinkityConfig })
        server = await createServer({
          ...ssrViteConfig,
          server: {
            middlewareMode: 'ssr',
          },
        })
        return server
      },
    }
  } else {
    const builder = toBuilder(async function buildModule(filePath) {
      const viteOutput = await viteBuild({
        dir,
        filePath,
        ssrViteConfig: await toViteConfig({ dir, userSlinkityConfig }),
        environment,
      })
      return viteOutput
    })
    return {
      async toCommonJSModule(filePath) {
        return builder.build(filePath, null, { shouldUseCache: true })
      },
      getServer() {
        return null
      },
      createServer() {
        return null
      },
    }
  }
}

module.exports.toViteSSR = toViteSSR
