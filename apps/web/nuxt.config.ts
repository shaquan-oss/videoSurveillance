// Nuxt 配置。
//
// 一个关键决定：前端不直接跨域访问后端，而是把 /api 反代到接口服务。
// 好处有三：
//   1. 浏览器看到的是同源请求，会话 Cookie（SameSite=Lax）才会自动带上，
//      否则要开 SameSite=None 并强制 HTTPS，本地开发根本没法用；
//   2. 省掉 CORS 配置与预检请求往返；
//   3. 生产环境由 Caddy 做同样的转发，开发与线上路径完全一致，不会「本地能跑线上502」。
export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  // 关掉遥测：首次启动它会弹交互式询问，在后台/容器里跑会直接卡住
  telemetry: false,
  srcDir: 'app/',

  // 端口显式指定。Nuxt 默认 3000，本机上已被别的项目占用，
  // 用环境变量 WEB_PORT 覆盖，避免每次启动都撞端口。
  devServer: {
    port: Number(process.env.WEB_PORT ?? 3100),
    host: '127.0.0.1',
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // 仅用于界面展示（如页脚显示环境），实际请求一律走同源 /api
      apiBase: '/api',
    },
  },

  // 把 /api 转发到 NestJS 接口服务。开发与生产都用这一条规则。
  routeRules: {
    '/api/**': {
      proxy: `${process.env.NUXT_API_PROXY ?? 'http://127.0.0.1:3101'}/api/**`,
    },
  },

  app: {
    head: {
      title: '企业智能知识中枢',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [{ charset: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  typescript: {
    strict: true,
  },

  // @kh/shared 是工作区内的 TypeScript 源码包（不是编译产物），
  // 需要显式告诉 Nuxt 去转译它，否则 Vite 会跳过 node_modules 里的 TS 导致报错。
  build: {
    transpile: ['@kh/shared'],
  },

  // 关掉 SSR 也可以（内部系统不需要 SEO），但保留 SSR 首屏更快、
  // 后续若要在服务端做鉴权跳转也更方便。需要时可改为 false。
  ssr: true,
});
