const { normalizePath } = require('vite')
const { relative } = require('path')
const {
  SLINKITY_ATTRS,
  SLINKITY_MOUNT_POINT,
  SLINKITY_HEAD_STYLES,
  toSSRComment,
} = require('../utils/consts')
const toSlashesTrimmed = require('../utils/toSlashesTrimmed')
const toLoaderScript = require('./toLoaderScript')
const loaders = require('./loaders')
const componentLoaderMap = Object.fromEntries(loaders.map((loader) => [loader.name, loader]))
const toHtmlAttrString = require('../utils/toHtmlAttrString')

const ssrRegex = RegExp(toSSRComment('([0-9]+)'), 'g')

/**
 * Test whether a route's output path is
 * Something Vite can / should transform
 * @param {any} outputPath
 * @return {boolean}
 */
function isSupportedOutputPath(outputPath) {
  return /\.html$/.test(outputPath)
}

/**
 * Process all SSR comments - server render components, apply scripts, inject styles into head
 * Extracted from applyViteHtmlTransform for unit testing!
 * @typedef HandleSSRCommentsParams
 * @property {string} content - the original HTML content to transform
 * @property {string} outputPath - the output path this HTML content will be written to
 * @property {import('./componentAttrStore').ComponentAttrStore} componentAttrStore
 * @property {import('../@types').ViteSSR} viteSSR
 * @property {import('../@types').Renderer[]} renderers
 * @property {Set<string>} importedStyles Styles imported by components on page
 * @property {Set<string>} inlineStyles Compiled styles to be injected as <style> tags
 * @param {HandleSSRCommentsParams}
 * @returns {Promise<string>} - HTML with components SSR'd
 */
async function handleSSRComments({
  content,
  outputPath,
  componentAttrStore,
  viteSSR,
  renderers,
  importedStyles = new Set(),
  inlineStyles = new Set(),
}) {
  /** @type {Record<string, any>} */
  const rendererMap = Object.fromEntries(renderers.map((renderer) => [renderer.name, renderer]))

  const pageComponentAttrs = componentAttrStore.getAllByPage(outputPath)
  const serverRenderedComponents = []
  for (const componentAttrs of pageComponentAttrs) {
    const { path: componentPath, props, isSSR, loader, rendererName, children } = componentAttrs
    const renderer = rendererMap[rendererName]
    if (renderer.injectImportedStyles) {
      const { __importedStyles } = await viteSSR.toCommonJSModule(componentPath)
      __importedStyles.forEach((importedStyle) => importedStyles.add(importedStyle))
    }
    if (isSSR) {
      const { default: serverRenderer } = await viteSSR.toCommonJSModule(renderer.server)
      const serverRendered = await serverRenderer({
        toCommonJSModule: viteSSR.toCommonJSModule,
        componentPath,
        props,
        children,
        loader,
      })
      if (serverRendered.css) {
        inlineStyles.add(serverRendered.css)
      }
      serverRenderedComponents.push(serverRendered.html)
    }
  }

  const html = content
    // server render each component
    .replace(ssrRegex, (_, id) => {
      const {
        path: componentPath,
        props,
        loader,
        isSSR,
        rendererName,
        children,
      } = pageComponentAttrs[id]
      const clientRenderer = rendererMap[rendererName].client
      const loaderScript = toLoaderScript({
        componentPath,
        componentLoaderMap,
        loader,
        isSSR,
        id,
        props,
        clientRenderer,
        children,
      })
      const attrs = toHtmlAttrString({ [SLINKITY_ATTRS.id]: id })
      const serverRenderedComponent = serverRenderedComponents[id] ?? ''
      return `<${SLINKITY_MOUNT_POINT} ${attrs}>${serverRenderedComponent}</${SLINKITY_MOUNT_POINT}>\n${loaderScript}`
    })

  if (html.match(ssrRegex)) {
    // if there's more SSR components, there are likely
    // components rendered by other components using shortcodes.
    // recursively render until all SSR comments are resolved.
    return handleSSRComments({
      content: html,
      outputPath,
      componentAttrStore,
      viteSSR,
      renderers,
      importedStyles,
      inlineStyles,
    })
  } else {
    return (
      html
        // inject component styles into head
        .replace(
          SLINKITY_HEAD_STYLES,
          [...importedStyles]
            .map((importedStyle) =>
              importedStyle.match(/&lang.*$/)
                ? // lang.(css|scss|sass...) is used by SFC (single file component) styles
                  // ex. <style scoped> in a .vue file
                  // these are sadly *not* supported by <link> tag imports,
                  // so we'll switch to <script> as a compromise
                  // Note: this does cause FOUC
                  // See this issue log for more details: https://github.com/slinkity/slinkity/issues/84#issuecomment-1003783754
                  `<script ${toHtmlAttrString({ type: 'module', src: importedStyle })}></script>`
                : `<link ${toHtmlAttrString({ rel: 'stylesheet', href: importedStyle })}>`,
            )
            .concat([...inlineStyles].map((inlineStyle) => `<style>${inlineStyle}</style>`))
            .join('\n'),
        )
    )
  }
}

/**
 * @typedef {import('../@types').EleventyConfigParams} EleventyConfigParams
 *
 * @typedef ApplyViteHtmlTransformParams
 * @property {string} content - the original HTML content to transform
 * @property {string} outputPath - the output path this HTML content will be written to
 * @property {import('./componentAttrStore').ComponentAttrStore} componentAttrStore
 * @property {import('../@types').Renderer[]} renderers
 * @property {EleventyConfigParams['environment']} environment
 * @property {EleventyConfigParams['dir']} dir
 * @property {EleventyConfigParams['viteSSR']} viteSSR
 * @param {ApplyViteHtmlTransformParams}
 * @returns {Promise<string>} - HTML with statically rendered content and Vite transforms applied
 */
async function applyViteHtmlTransform({
  content,
  outputPath,
  componentAttrStore,
  environment,
  viteSSR,
  renderers,
  dir,
}) {
  if (!isSupportedOutputPath(outputPath)) {
    return content
  }
  const html = await handleSSRComments({
    content,
    outputPath,
    componentAttrStore,
    viteSSR,
    renderers,
  })
  const server = viteSSR.getServer()
  const routePath = '/' + toSlashesTrimmed(normalizePath(relative(dir.output, outputPath)))
  return environment === 'development' && server ? server.transformIndexHtml(routePath, html) : html
}

module.exports = { applyViteHtmlTransform, handleSSRComments, isSupportedOutputPath }
