import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(

  {
    ignores: [
      "dist",
      "node_modules",
      ".vite",
      ".cloudflare",
      ".wrangler",
      "coverage"
    ],
  },

  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],

    files: ["**/*.{ts,tsx}"],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2021
      },
    },

    settings: {
      react: {
        version: "detect",
      },
    },

    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },

    rules: {

      /**
       * React Hooks correctness
       */

      ...reactHooks.configs.recommended.rules,


      /**
       * Vite fast-refresh safety
       */

      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true }
      ],


      /**
       * AETERNA project policy:
       * allow unused variables during protocol-layer development
       */

      "@typescript-eslint/no-unused-vars": "off",

    },

  }

);