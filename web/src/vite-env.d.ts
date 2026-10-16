/// <reference types="vite/client" />

/**
 * Build-time environment variables exposed to the SPA.
 *
 * These are inlined by Vite at build time, so they are only readable through
 * `import.meta.env` — never `process.env`. `VITE_API_BASE_URL` is what lets a
 * Firebase-Hosted SPA reach an API on another origin; see docs/deployment.md.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
