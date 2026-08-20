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
            entry: resolve(__dirname, "src/emergency/emergencyRuntime.ts"),
            formats: ["es"],
            fileName: () => "scripts/emergency-runtime.js",
        },

        rollupOptions: {
            output: {
                entryFileNames: "scripts/emergency-runtime.js",
            },
        },
    },
});
