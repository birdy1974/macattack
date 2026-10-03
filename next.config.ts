import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep image optimization disabled: the Docker image ships without `sharp`
  // and targets ARM as well as x86_64. The brand mark is served directly from
  // its source URL instead of going through Next's image optimizer.
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ih1.redbubble.net",
        pathname: "/image.5307335794.8778/**",
      },
    ],
  },
};

export default nextConfig;
