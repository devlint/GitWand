/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** App version injected at build time from package.json via vite.config.ts `define`. */
declare const __APP_VERSION__: string;
