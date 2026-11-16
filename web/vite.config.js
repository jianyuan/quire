import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url)));

// Everything in "dependencies" ships in dist/, including the CSS-only
// packages (fonts, Tailwind, daisyUI) that Vite's own build.license misses,
// so this writes all their licenses to dist/licenses.md for the Go server
// to embed and serve at /licenses. Build tools stay in devDependencies.
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

// In development Vite serves the page and forwards the API to the Go
// server (make dev runs both); in production Go embeds dist/.
export default defineConfig({
  plugins: [tailwindcss(), licenses()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/raw": "http://127.0.0.1:8080",
    },
  },
});
