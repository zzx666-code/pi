import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The desk runs on its own port so a customer and an operator can sit side by side during a demo.
 *
 * Vite serves a single port per process, so this is a second server over the same source tree
 * rather than a route inside {@link file://./vite.config.ts}. The desk owns its whole port, so a
 * rewrite sends the bare root at the desk entry instead of the customer page.
 */
export default defineConfig({
	plugins: [
		react(),
		{
			name: "desk-entry-rewrite",
			configureServer(server) {
				server.middlewares.use((request, _response, next) => {
					if (request.url === "/" || request.url === "/index.html") request.url = "/desk.html";
					next();
				});
			},
		},
	],
	build: { outDir: "dist-web-desk", rollupOptions: { input: "desk.html" } },
	server: {
		host: "127.0.0.1",
		port: 5134,
		proxy: { "/api": "http://127.0.0.1:3100", "/health": "http://127.0.0.1:3100" },
	},
});
