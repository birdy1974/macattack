import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // MacAttack renders no images and the Docker image ships without `sharp`
  // (it is x86_64-only in the standalone output and would break the arm64
  // image used on a Raspberry Pi 4). This keeps the image optimizer out of
  // the picture entirely, so a future <Image> serves the original file
  // instead of crashing at runtime.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
