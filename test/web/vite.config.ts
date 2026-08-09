import { fileURLToPath, URL } from "node:url";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
    base: "./",
    build: {
        emptyOutDir: true,
        outDir: fileURLToPath(new URL("../../dist-web", import.meta.url)),
    },
    plugins: [svelte()],
    root: fileURLToPath(new URL(".", import.meta.url)),
});
