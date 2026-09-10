import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from a repo subpath on GitHub Pages, so asset URLs must be relative.
  base: "./",
  plugins: [react()],
});
