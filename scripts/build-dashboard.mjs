import { build } from "esbuild";

await build({
  entryPoints: ["src/dashboard-client.tsx"],
  outfile: "dist/dashboard-client.browser.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  minify: false,
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production")
  }
});
