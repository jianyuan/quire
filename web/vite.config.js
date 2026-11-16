import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url)));

// Everything in "dependencies" ships in dist/. Vite's own build.license
// misses packages that only CSS imports (the fonts, Tailwind and daisyUI),
// so this plugin writes every dependency's licence to dist/licenses.md.
// The Go server embeds it and serves it at /licenses. Build tools belong
// in devDependencies.
function licenses() {
  return {
    name: "licenses",
    apply: "build",
    generateBundle() {
      const sections = Object.keys(pkg.dependencies).sort().map((name) => {
        const dir = new URL(`node_modules/${name}/`, import.meta.url);
        const meta = JSON.parse(readFileSync(new URL("package.json", dir)));
        if (Object.keys(meta.dependencies ?? {}).length) {
          this.error(`${name} has its own dependencies; list their licenses too`);
        }
        const files = readdirSync(dir).filter((f) => /^licen[cs]e/i.test(f));
        const file = files.find((f) => /^license(\.md|\.txt)?$/i.test(f)) ?? files[0];
        if (!file) this.error(`${name} has no license file`);
        const text = readFileSync(new URL(file, dir), "utf8").trim();
        return `## ${name} ${meta.version} (${meta.license})\n\n${text}\n`;
      });
      this.emitFile({
        type: "asset",
        fileName: "licenses.md",
        source: `# Web app dependencies\n\n${sections.join("\n")}`,
      });
    },
  };
}

// In development, Vite serves the page and forwards API requests to the Go
// server. make dev runs both. In production, the Go binary embeds dist/.
export default defineConfig({
  plugins: [tailwindcss(), licenses()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/raw": "http://127.0.0.1:8080",
    },
  },
});
