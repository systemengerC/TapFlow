import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // contracts 是源码形态的 workspace 包（main 指向 .ts），需 Next 参与转译
  transpilePackages: ['@tapflow/contracts'],
};

export default nextConfig;
