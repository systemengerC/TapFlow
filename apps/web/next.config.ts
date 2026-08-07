import type { NextConfig } from "next";

// 本地开发时 API 与 web 不同源（API 默认 :8650，web :3000），API 未开 CORS。
// 用 Next rewrites 做同源代理，前端 hook 里的 API_BASE 保持空字符串即可。
// 生产部署若 API 与 web 同源（同一反代之后），不设 API_PROXY_TARGET 即不生成 rewrite。
const API_PROXY_TARGET = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  // contracts 是源码形态的 workspace 包（main 指向 .ts），需 Next 参与转译
  transpilePackages: ['@tapflow/contracts'],

  async rewrites() {
    if (!API_PROXY_TARGET) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
