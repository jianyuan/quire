import { readFileSync, readdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

// Everything in "dependencies" ships in dist/. Vite's own build.license
// misses packages that only CSS imports (the fonts, Tailwind and daisyUI),
// so this plugin writes every dependency's licence to dist/licenses.md.
// The Go server embeds it and serves it at /licenses. Build tools belong
// in devDependencies.
function licenses(): Plugin {
  let mode: string;
  return {
    name: "licenses",
    apply: "build",
    configResolved(config) {
      mode = config.mode;
    },
    generateBundle() {
      const sections = Object.keys(pkg.dependencies).sort().map((name) => {
        const dir = new URL(`node_modules/${name}/`, import.meta.url);
        const meta = JSON.parse(readFileSync(new URL("package.json", dir), "utf8"));
        if (Object.keys(meta.dependencies ?? {}).length) {
          this.error(`${name} has its own dependencies; list their licenses too`);
        }
        const files = readdirSync(dir).filter((f) => /^licen[cs]e/i.test(f));
        const file = files.find((f) => /^license(\.md|\.txt)?$/i.test(f)) ?? files[0];
        if (!file) this.error(`${name} has no license file`);
        const text = readFileSync(new URL(file, dir), "utf8").trim();
        return `## ${name} ${meta.version} (${meta.license})\n\n${text}\n`;
      });
      const source = `# Web app dependencies\n\n${sections.join("\n")}`;
      this.emitFile({ type: "asset", fileName: "licenses.md", source });
      // GitHub Pages would offer a .md file as a download, so the static
      // build links to a plain-text copy instead.
      if (mode === "pages") {
        this.emitFile({ type: "asset", fileName: "licenses.txt", source });
      }
    },
  };
}

// In development, Vite serves the page and forwards API requests to the Go
// server. make dev runs both. In production, the Go binary embeds dist/.
//
// The "pages" mode builds a static copy into dist-pages/ for GitHub Pages.
// It has no server: visitors open a file or folder from their own disk.
// Relative asset paths let it work under /quire/ or on a custom domain.
export default defineConfig(({ mode }) => ({
  plugins: [tailwindcss(), licenses()],
  ...(mode === "pages" && { base: "./", build: { outDir: "dist-pages" } }),
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/raw": "http://127.0.0.1:8080",
    },
  },
}));
