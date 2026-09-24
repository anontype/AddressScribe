import js from "@eslint/js";

const nodeGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly"
};

const browserGlobals = {
  AbortController: "readonly",
  HTMLInputElement: "readonly",
  Intl: "readonly",
  navigator: "readonly",
  document: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  TextDecoder: "readonly",
  window: "readonly"
};

const workerGlobals = {
  caches: "readonly",
  fetch: "readonly",
  self: "readonly",
  URL: "readonly"
};

export default [
  {
    ignores: ["node_modules/**", "coverage/**", ".addressscribe/**"]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.js", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    }
  },
  {
    files: ["public/app.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals
    }
  },
  {
    files: ["public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: workerGlobals
    }
  }
];
