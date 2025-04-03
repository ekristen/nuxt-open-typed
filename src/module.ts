import { existsSync, readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { FetchOptions } from 'ofetch'
import type { OpenAPI3, OpenAPITSOptions } from 'openapi-typescript'
import {
  addImportsSources,
  addPlugin,
  addServerImports,
  addServerPlugin,
  addTemplate,
  addTypeTemplate,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { camelCase, kebabCase, pascalCase } from 'scule'
import { join } from 'pathe'

import type { OpenAPIObject } from "openapi3-ts/oas31";
import SwaggerParser from "@apidevtools/swagger-parser";
import { generateFile, mapOpenApiEndpoints } from 'typed-openapi'
import type { OutputRuntime } from 'typed-openapi'
import { fileURLToPath } from 'node:url'

type OpenAPI3Schema = string | URL | OpenAPI3 | Readable

export interface OpenTypedOptions extends Pick<FetchOptions, 'baseURL' | 'query' | 'headers'> { }

export interface OpenTypedClientOptions extends OpenTypedOptions {
  schema?: OpenAPI3Schema
  runtime?: OutputRuntime
}

export interface ModuleOptions {
  clients?: Record<string, OpenTypedClientOptions>
  disableNuxtPlugin?: boolean
  disableNitroPlugin?: boolean
}

interface ResolvedSchema {
  name: string
  schema: OpenAPI3Schema
  runtime: OutputRuntime
}

const moduleName = 'open-typed'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: `nuxt-${moduleName}`,
    configKey: camelCase(moduleName),
    compatibility: {
      nuxt: '^3.0.0',
    },
  },
  async setup(options, nuxt) {
    if (!options.clients)
      return

    const { resolve } = createResolver(import.meta.url)
    const schemas: ResolvedSchema[] = []

    nuxt.options.runtimeConfig.public.openFetch = Object.fromEntries(Object.entries(options.clients)
      .map(([key, { schema: _, ...options }]) => [key, options])) as any

    for (const layer of nuxt.options._layers) {
      const { srcDir, openTyped } = layer.config
      const schemasDir = resolve(srcDir, 'openapi')
      const layerClients = Object.entries(options.clients).filter(([key]) => openTyped?.clients?.[key])

      for (const [name, config] of layerClients) {
        // Skip if schema already added by upper layer or if config is not defined
        if (schemas.some(item => item.name === name) || !config)
          continue

        let schema: OpenAPI3Schema | undefined = config.schema

        if (!config.schema) {
          const jsonPath = resolve(schemasDir, `${name}/openapi.json`)
          const yamlPath = resolve(schemasDir, `${name}/openapi.yaml`)

          schema = existsSync(jsonPath) ? jsonPath : existsSync(yamlPath) ? yamlPath : undefined
          schema = schema ? new URL(`file://${schema}`) : undefined
        }
        else if (typeof config.schema === 'string') {
          schema = isValidUrl(config.schema) ? config.schema : new URL(`file://${resolve(srcDir, config.schema)}`)
        }

        if (!schema)
          throw new Error(`Could not find OpenAPI schema for "${name}"`)

        schemas.push({
          name,
          schema,
          runtime: config.runtime || 'zod',
        })
      }
    }

    nuxt.options.alias = {
      ...nuxt.options.alias,
      '#open-typed': join(nuxt.options.buildDir, moduleName),
      '#open-typed-schemas/*': join(nuxt.options.buildDir, 'types', moduleName, 'schemas', '*'),
    }

    nuxt.options.optimization = nuxt.options.optimization || {
      keyedComposables: [],
    }

    nuxt.options.optimization.keyedComposables = [
      ...nuxt.options.optimization.keyedComposables,
    ]

    schemas.forEach(({ name, schema, runtime }) => {
      addTemplate({
        filename: `types/${moduleName}/schemas/${kebabCase(name)}-${runtime}.ts`,
        getContents: async () => {
          const schemaPath = fileURLToPath(schema as URL)
          const openApiDoc = (await SwaggerParser.bundle(schemaPath)) as OpenAPIObject;
          const ctx = mapOpenApiEndpoints(openApiDoc);
          const content = generateFile({ ...ctx, runtime: runtime });
          return content
        },
        write: true,
      })
    })

  },
})

function isValidUrl(url: string) {
  try {
    return Boolean(new URL(url))
  }
  catch {
    return false
  }
}
