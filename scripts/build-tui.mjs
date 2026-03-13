import { build } from "esbuild";

await build({
  entryPoints: ["src/tui.tsx"],
  outfile: "dist/tui.mjs",
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: ["node22"],
  sourcemap: false,
  minify: false,
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production")
  }
});
