const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/index.ts"],
    outdir: "dist",
    bundle: true,
    format: "esm",
    splitting: true,
    sourcemap: true,
    target: ["esnext"],
    loader: { ".ts": "ts" },
    watch: process.argv.includes("--watch"), // Optional: Watch mode
  })
  .then(() => {
    console.log("Build completed");
  })
  .catch(() => process.exit(1));
