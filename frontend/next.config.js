/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Wagmi connector re-exports pull optional deps that are not needed in this app.
    // Alias them out to avoid compile-time resolution errors in Next.js.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };

    return config;
  },
};

module.exports = nextConfig;
