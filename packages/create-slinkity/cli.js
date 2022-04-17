#!/usr/bin/env node
const path = require('path')
const fs = require('fs')
const { yellow, red } = require('kolorist')
const prompts = require('prompts')

const ELEVENTY_CONFIG = '.eleventy.js'
const INDEX_MD = 'src/index.md'
const LAYOUT_NJK = 'src/_includes/layout.njk'
const PKG = 'package.json'
const filesToPreprocess = new Set([ELEVENTY_CONFIG, INDEX_MD, PKG, LAYOUT_NJK])

const RENDERER_IMPORT_COMMENT = '// insert renderer imports here'
const RENDERER_CONFIG_COMMENT = '/* apply component renderers here */'

const componentFlavorMeta = {
  react: {
    packageJson: {
      dependencies: {
        react: '^17.0.2',
        'react-dom': '^17.0.2',
      },
      devDependencies: {
        '@slinkity/renderer-react': '^1.0.0',
      },
    },
    slinkityConfig: {
      renderer: 'react',
      importStatement: "const react = require('@slinkity/renderer-react')",
    },
    navLink: {
      href: '/react-page',
      text: 'React',
    },
    shortcode: '{% component "Slinky.jsx", hydrate=true %}',
    exclusiveTemplates: ['src/react-page.jsx', 'src/_includes/Slinky.jsx', 'styles/slinky.scss'],
  },
  vue: {
    packageJson: {
      dependencies: {
        vue: '^3.2.28',
      },
      devDependencies: {
        '@slinkity/renderer-vue': '^1.0.0',
      },
    },
    slinkityConfig: {
      renderer: 'vue',
      importStatement: "const vue = require('@slinkity/renderer-vue')",
    },
    navLink: {
      href: '/vue-page',
      text: 'Vue',
    },
    shortcode: '{% component "Slinky.vue", hydrate=true %}',
    exclusiveTemplates: ['src/vue-page.vue', 'src/_includes/Slinky.vue'],
  },
  svelte: {
    packageJson: {
      dependencies: {
        svelte: '^3.46.2',
      },
      devDependencies: {
        '@slinkity/renderer-svelte': '^1.0.0',
      },
    },
    slinkityConfig: {
      renderer: 'svelte',
      importStatement: "const svelte = require('@slinkity/renderer-svelte')",
    },
    navLink: {
      href: '/svelte-page',
      text: 'Svelte',
    },
    shortcode: '{% component "Slinky.svelte", hydrate=true %}',
    exclusiveTemplates: ['src/svelte-page.svelte', 'src/_includes/Slinky.svelte'],
  },
}

function applyRenderersToEleventyConfig(eleventyConfigContents, selectedComponentFlavors) {
  let updatedEleventyConfig = eleventyConfigContents
  const renderers = selectedComponentFlavors.map(
    (flavor) => componentFlavorMeta[flavor].slinkityConfig.renderer,
  )
  if (renderers) {
    updatedEleventyConfig = updatedEleventyConfig.replace(
      RENDERER_CONFIG_COMMENT,
      renderers.join(', '),
    )
  }
  const imports = selectedComponentFlavors.map(
    (flavor) => '\n' + componentFlavorMeta[flavor].slinkityConfig.importStatement,
  )
  updatedEleventyConfig = updatedEleventyConfig.replace(RENDERER_IMPORT_COMMENT, imports.join(''))
  return updatedEleventyConfig
}

;(async () => {
  let dest = process.argv[2]
  const promptResponses = await prompts([
    {
      type: dest ? null : 'text',
      name: 'dest',
      message: 'What is your project called?',
      initial: 'my-slinkity-site',
    },
    {
      type: 'multiselect',
      name: 'components',
      message: 'What flavor of components do you want, if any?',
      choices: [
        { title: 'React', value: 'react' },
        { title: 'Vue', value: 'vue' },
        { title: 'Svelte', value: 'svelte' },
      ],
    },
  ])
  if (!dest) {
    dest = promptResponses.dest
  }
  // if there's no dest provided as a CLI argument OR by a prompt,
  // they must have ctrl + C'd out of the program
  if (!dest) process.exit(0)

  const srcResolved = path.join(__dirname, 'template')
  const destResolved = path.join(process.cwd(), dest)
  fs.mkdirSync(destResolved)

  // copy files to output
  const templates = fs.readdirSync(srcResolved)
  const componentTemplates = new Set(
    Object.values(componentFlavorMeta).flatMap(({ exclusiveTemplates }) => exclusiveTemplates),
  )
  const selectedComponentTemplates = new Set(
    promptResponses.components.flatMap(
      (component) => componentFlavorMeta[component].exclusiveTemplates,
    ),
  )
  for (const template of templates) {
    const src = path.join(srcResolved, template)
    const dest = path.join(destResolved, template)
    copy(src, dest, (filePath) => {
      // check whether or not we should copy the file
      const relativePath = path.relative(srcResolved, filePath)
      const isFileToPreprocess = filesToPreprocess.has(relativePath)
      const isOmittedComponentTemplate =
        componentTemplates.has(relativePath) && !selectedComponentTemplates.has(relativePath)
      return isFileToPreprocess || isOmittedComponentTemplate
    })
  }

  // package.json
  const pkg = require(path.join(srcResolved, PKG))
  pkg.name = toValidPackageName(dest)
  for (const componentFlavor of promptResponses.components) {
    pkg.dependencies = {
      ...pkg.dependencies,
      ...componentFlavorMeta[componentFlavor].packageJson.dependencies,
    }
    pkg.devDependencies = {
      ...pkg.devDependencies,
      ...componentFlavorMeta[componentFlavor].packageJson.devDependencies,
    }
  }
  fs.writeFileSync(path.join(destResolved, PKG), JSON.stringify(pkg, null, 2))

  // index.md
  const indexMd = fs.readFileSync(path.join(srcResolved, INDEX_MD)).toString()
  const shortcodes = promptResponses.components.map(
    (componentFlavor) => componentFlavorMeta[componentFlavor].shortcode,
  )
  fs.writeFileSync(
    path.join(destResolved, INDEX_MD),
    indexMd.replace('<!--insert-component-shortcodes-here-->', shortcodes.join('\n')),
  )

  // layout.njk
  const layoutNjk = fs.readFileSync(path.join(srcResolved, LAYOUT_NJK)).toString()
  const navLinks = promptResponses.components.map((componentFlavor) => {
    const { href, text } = componentFlavorMeta[componentFlavor].navLink
    return `<a href="${href}">${text}</a>`
  })
  fs.writeFileSync(
    path.join(destResolved, LAYOUT_NJK),
    layoutNjk.replace('<!--insert-nav-links-here-->', navLinks.join('\n      ')),
  )

  // slinkity plugin config
  const eleventyConfig = fs.readFileSync(path.join(srcResolved, ELEVENTY_CONFIG)).toString()
  fs.writeFileSync(
    path.join(destResolved, ELEVENTY_CONFIG),
    applyRenderersToEleventyConfig(eleventyConfig, promptResponses.components),
  )

  console.log(`Welcome to your first ${yellow('Slinkity site!')}`)
  console.log('Step 1: run these commands to install and serve locally 👇')
  console.log(`
cd ${dest}
npm i
npm start
`)
  console.log(`Step 2: ${red('have fun ❤️')}`)
})()

/**
 * Util to copy file or file directory to dest
 * Inspired by https://github.com/vitejs/vite/blob/main/packages/create-vite/index.js
 * @param {string} src
 * @param {string} dest
 * @param {(filePath: string) => boolean} shouldOmit
 */
function copy(src, dest, shouldOmit) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    copyDir(src, dest, shouldOmit)
  } else if (!shouldOmit(src)) {
    fs.copyFileSync(src, dest)
  }
}

/**
 * Util to copy file directory to test
 * Inspired by https://github.com/vitejs/vite/blob/main/packages/create-vite/index.js
 * @param {string} srcDir
 * @param {string} destDir
 * @param {(filePath: string) => boolean} shouldOmit
 */
function copyDir(srcDir, destDir, shouldOmit) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.resolve(srcDir, file)
    const destFile = path.resolve(destDir, file)
    copy(srcFile, destFile, shouldOmit)
  }
}

/**
 * Util to convert a project name into a valid package name for a package.json
 * Inspired by https://github.com/vitejs/vite/blob/main/packages/create-vite/index.js
 * @param {string} projectName
 * @returns {string} A valid package name
 */
function toValidPackageName(projectName) {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]/, '')
    .replace(/[^a-z0-9-~]+/g, '-')
}
