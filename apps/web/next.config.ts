import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@fuduo/shared"],
  reactStrictMode: true,
  async rewrites() {
    const target = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
