import { defineConfig, type ViteDevServer } from "vite"
import react from "@vitejs/plugin-react-swc"
import path from "path"
import { fileURLToPath } from "url"
import { componentTagger } from "lovable-tagger"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import type { IncomingMessage, ServerResponse } from "http"

const __dirname =
  path.dirname(
    fileURLToPath(import.meta.url)
  )

export default defineConfig(({ mode }) => {

  const isDev =
    mode === "development"

  return {

    base: "/",

    define: {
      __DEV__: isDev
    },

    server: {

      host: "::",

      port: 8080,

      strictPort: true,

      cors: false,

      configureServer(
        server: ViteDevServer
      ) {

        if (!isDev) return

        server.middlewares.use(
          "/api/time",
          (
            req: IncomingMessage,
            res: ServerResponse
          ) => {

            res.setHeader(
              "Access-Control-Allow-Origin",
              req.headers.origin ?? "*"
            )

            res.setHeader(
              "Access-Control-Allow-Methods",
              "GET, OPTIONS"
            )

            res.setHeader(
              "Access-Control-Allow-Headers",
              "Content-Type"
            )

            res.setHeader(
              "Cache-Control",
              "no-store"
            )

            res.setHeader(
              "Content-Type",
              "application/json"
            )

            if (req.method === "OPTIONS") {

              res.statusCode = 204
              res.end()

              return

            }

            if (req.method !== "GET") {

              res.statusCode = 405

              res.end(
                JSON.stringify({
                  error:
                    "Method Not Allowed"
                })
              )

              return

            }

            res.end(
              JSON.stringify({
                nowUtc:
                  Date.now()
              })
            )

          }
        )

      },

    },

    optimizeDeps: {

      include: [

        "buffer",

        "process"

      ]

    },

    plugins: [

      nodePolyfills({

        include: [

          "stream",

          "events",

          "buffer",

          "util",

          "crypto"

        ],

        globals: {

          Buffer: true,

          process: true

        }

      }),

      react(),

      ...(isDev
        ? [componentTagger()]
        : [])

    ],

    resolve: {

      alias: {

        "@":
          path.resolve(
            __dirname,
            "./src"
          ),

        "@/lib/capsule/loadManifest":
          isDev
            ? path.resolve(
                __dirname,
                "./src/lib/capsule/loadManifest.dev.ts"
              )
            : path.resolve(
                __dirname,
                "./src/lib/capsule/loadManifest.ts"
              ),

        "@/lib/storage":
          isDev
            ? path.resolve(
                __dirname,
                "./src/lib/storage/devStorage.ts"
              )
            : path.resolve(
                __dirname,
                "./src/lib/storage/index.ts"
              )

      }

    },

    build:

      isDev

        ? undefined

        : {

            outDir: "dist",

            sourcemap: false,

            reportCompressedSize:
              false,

            commonjsOptions: {

              transformMixedEsModules:
                true

            },

            rollupOptions: {}

          }

  }

})