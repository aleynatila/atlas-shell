import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ["xterm", "xterm-addon-fit", "xterm-addon-webgl"],
          lucide: ["lucide-react"],
        },
      },
    },
    commonjsOptions: {
      include: [/react-window/, /node_modules/],
    },
  },
});
