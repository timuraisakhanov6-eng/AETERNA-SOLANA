import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({

    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
        },
    },

    build: {
        outDir: "dist",
        emptyOutDir: false,
        sourcemap: false,

        lib: {
            entry: resolve(__dirname, "src/runtime-sw.ts"),
            formats: ["es"],
            fileName: () => "runtime-sw.js",
        },

        rollupOptions: {
            output: {
                entryFileNames: "runtime-sw.js",
            },
        },
    },

});