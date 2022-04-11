const { normalizePath } = require('vite')
const { relative } = require('path')
const toSlashesTrimmed = require('./utils/toSlashesTrimmed')
const { getResolvedImportAliases } = require('./cli/vite')
const { toComponentAttrStore } = require('./eleventyConfig/componentAttrStore')
const {
  applyViteHtmlTransform,
  isSupportedOutputPath,
} = require('./eleventyConfig/applyViteHtmlTransform')
const addComponentPages = require('./eleventyConfig/addComponentPages')
const addComponentShortcodes = require('./eleventyConfig/addComponentShortcodes')
const { SLINKITY_HEAD_STYLES } = require('./utils/consts')
const {
  toEleventyIgnored,
  defaultExtensions,
} = require('./eleventyConfig/handleTemplateExtensions')
const { toViteSSR } = require('./cli/toViteSSR')

/**
 * @param {any} eleventyConfig
 * @param {import('./@types').UserSlinkityConfig} userSlinkityConfig
 */
module.exports.plugin = function plugin(eleventyConfig, userSlinkityConfig) {
  // TODO: infer from CLI flags
  let environment = 'development'

  console.log({ dir: eleventyConfig.dir })

  /** @type {{ dir: import('./@types').Dir }} */
  const { dir } = eleventyConfig
  /** @type {import('./@types').ViteSSR} */
  let viteSSR = null

  /** @type {import('./eleventyConfig/handleTemplateExtensions').ExtensionMeta[]} */
  const ignoredFromRenderers = userSlinkityConfig.renderers.flatMap((renderer) =>
    renderer.extensions.map((extension) => ({
      extension,
      isTemplateFormat: typeof renderer.page === 'function',
      isIgnoredFromIncludes: true,
    })),
  )
  const extensionMeta = [...defaultExtensions, ...ignoredFromRenderers]
  const componentAttrStore = toComponentAttrStore()

  eleventyConfig.addTemplateFormats(
    extensionMeta.filter((ext) => ext.isTemplateFormat).map((ext) => ext.extension),
  )

  const eleventyIgnored = toEleventyIgnored(
    userSlinkityConfig.eleventyIgnores,
    getResolvedImportAliases(dir).includes,
    extensionMeta,
  )

  for (const ignored of eleventyIgnored) {
    eleventyConfig.ignores.add(ignored)
  }

  eleventyConfig.addGlobalData('__slinkity', {
    head: SLINKITY_HEAD_STYLES,
  })

  addComponentShortcodes({
    renderers: userSlinkityConfig.renderers,
    eleventyConfig,
    componentAttrStore,
    importAliases: getResolvedImportAliases(dir),
  })
  for (const renderer of userSlinkityConfig.renderers) {
    if (renderer.page) {
      addComponentPages({
        renderer,
        eleventyConfig,
        componentAttrStore,
        importAliases: getResolvedImportAliases(dir),
      })
    }
  }

  if (environment === 'development') {
    /** @type {Record<string, string>} */
    const urlToViteTransformMap = {}
    /** @type {import('vite').ViteDevServer} */
    let viteMiddlewareServer = null

    eleventyConfig.setServerOptions({
      async setup() {
        if (!viteMiddlewareServer) {
          if (!viteSSR) {
            viteSSR = await toViteSSR({
              dir,
              environment,
              userSlinkityConfig,
            })
          }
          viteMiddlewareServer = await viteSSR.createServer()
        }
      },
      middleware: [
        (req, res, next) => {
          // Some Vite server middlewares are missing content types
          // Set to text/plain as a safe default
          res.setHeader('Content-Type', 'text/plain')
          return viteMiddlewareServer.middlewares(req, res, next)
        },
        async function viteTransformMiddleware(req, res, next) {
          const page = urlToViteTransformMap[toSlashesTrimmed(req.url)]
          if (page) {
            const { content, outputPath } = page
            res.setHeader('Content-Type', 'text/html')
            res.write(
              await applyViteHtmlTransform({
                content,
                outputPath,
                componentAttrStore,
                renderers: userSlinkityConfig.renderers,
                dir,
                viteSSR,
                environment,
              }),
            )
            res.end()
          } else {
            next()
          }
        },
      ],
    })

    eleventyConfig.on('beforeBuild', () => {
      componentAttrStore.clear()
    })

    eleventyConfig.addTransform('update-url-to-vite-transform-map', function (content, outputPath) {
      if (!isSupportedOutputPath(outputPath)) return content

      const relativePath = relative(dir.output, outputPath)
      const formattedAsUrl = toSlashesTrimmed(
        normalizePath(relativePath)
          .replace(/.html$/, '')
          .replace(/index$/, ''),
      )
      urlToViteTransformMap[formattedAsUrl] = {
        outputPath,
        content,
      }
      return content
    })
  }

  // if (environment === 'production') {
  //   eleventyConfig.addTransform('apply-vite', async function (content, outputPath) {
  //     return await applyViteHtmlTransform({
  //       content,
  //       outputPath,
  //       componentAttrStore,
  //       renderers: userSlinkityConfig.renderers,
  //       ...options,
  //     })
  //   })
  //   eleventyConfig.on('after-build', async function viteProductionBuild() {
  //     const intermediateDir = relative('.', await mkdtemp('.11ty-build-'))
  //     await viteBuild({
  //       userSlinkityConfig,
  //       eleventyDir: userConfigDir,
  //       input: intermediateDir,
  //       output: outputDir,
  //     })
  //   })
  // }
  return {}
}