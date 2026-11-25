import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OCR (2026-11-25): tesseract.js spawns its worker thread from a path
  // computed with `path.join(__dirname, ...)` and reads its WASM core and
  // English language data with `fs` — none of that survives bundling, so
  // the OCR packages stay runtime requires, and the files they read
  // dynamically (worker script, WASM core, language data) are forced into
  // the upload route's serverless bundle by the tracing includes below.
  serverExternalPackages: [
    "tesseract.js",
    "tesseract.js-core",
    "@tesseract.js-data/eng",
  ],
  outputFileTracingIncludes: {
    "/api/documents/upload": [
      "./node_modules/tesseract.js/**",
      "./node_modules/tesseract.js-core/**",
      "./node_modules/@tesseract.js-data/eng/**",
    ],
  },
};

export default nextConfig;
