import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// In development Vite serves the page and forwards the API to the Go
// server (make dev runs both); in production Go embeds dist/.
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/raw": "http://127.0.0.1:8080",
    },
  },
});
