// Bundles the widget into dist/inject.js, the one script a site embeds. With --serve, it rebuilds
// on every change and serves this folder: open http://localhost:8000/demo.html.
import * as esbuild from "esbuild";
import { resolve } from "node:path";

const serve = process.argv.includes("--serve");

/** Imports a stylesheet as minified text, with the images it uses inlined. */
const cssAsText = {
  name: "css-as-text",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const { outputFiles, metafile } = await esbuild.build({
        entryPoints: [path],
        bundle: true,
        minify: true,
        write: false,
        metafile: true,
        loader: { ".svg": "dataurl" },
      });
      return {
        contents: outputFiles[0].text,
        loader: "text",
        watchFiles: Object.keys(metafile.inputs).map((input) => resolve(input)),
      };
    });
  },
};

const options = {
  entryPoints: ["src/inject.js"],
  outfile: "dist/inject.js",
  bundle: true,
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  format: "iife",
  target: "es2022",
  loader: { ".html": "text", ".svg": "dataurl", ".png": "dataurl", ".mp3": "dataurl" },
  plugins: [cssAsText],
  define: {
    CHATBOT_API_URL: JSON.stringify(
      process.env.CHATBOT_API_URL ??
        "https://d4l7w3jjxpfu2wkjfqexkmcfuy0ingyn.lambda-url.ap-south-1.on.aws",
    ),
    RECAPTCHA_SITE_KEY: JSON.stringify(
      process.env.RECAPTCHA_SITE_KEY ?? "6LfgWgAqAAAAAAUnB69cbKEuxMVJJxDzs9lSP65v",
    ),
    // Too big to inline, so CI publishes it beside inject.js, and dev serves it from this folder.
    OPENER_URL: JSON.stringify(
      serve ? "/src/assets/opener.webp" : "https://chatbot.vinaiak.com/public/opener.webp",
    ),
  },
  logLevel: "info",
};

if (serve) {
  const context = await esbuild.context(options);
  await context.watch();
  await context.serve({ servedir: ".", port: 8000 });
} else {
  await esbuild.build(options);
}
