import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // libsql ships native bindings; bundling them breaks the driver at runtime.
  // Mirrors the same list on justin06lee.dev, which talks to the same database.
  serverExternalPackages: [
    "@libsql/client",
    "@libsql/core",
    "@libsql/hrana-client",
    "libsql",
  ],
};

export default nextConfig;
