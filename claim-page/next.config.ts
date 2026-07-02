import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@aztec/bb.js"],
  outputFileTracingIncludes: {
    // Update the route to the one where you need to verify ZKPassport proof
    '/api/register': ["./node_modules/@aztec/bb.js/dest/node/**/*", "./node_modules/@aztec/bb.js/dest/node-cjs/**/*"],
  },
};

export default nextConfig;
