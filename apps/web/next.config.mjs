/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Optional: Disable image optimization since it requires a server (or paid plan)
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
