/** 通过 wrangler rules type = "Text" 内联的 HTML 模块 */
declare module '*.html' {
  const content: string;
  export default content;
}

/**
 * wrangler 的 define 在打包时替换成字面量（见 wrangler.jsonc）。
 * `npm run dev` 为 true，`npm run build` / 正式部署为 false。
 */
declare const __TEST_ENDPOINTS__: boolean;

/** 版本指纹：正式部署时由 deploy.mjs 注入 commit SHA，本地 dev 为 "dev" */
declare const __BUILD_VERSION__: string;
