import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// In development, Vite serves the page and forwards API requests to the Go
// server. make dev runs both. In production, the Go binary embeds dist/.
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/raw": "http://127.0.0.1:8080",
    },
  },
});
