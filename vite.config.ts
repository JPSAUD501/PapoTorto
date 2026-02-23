import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        admin: "admin.html",
        history: "history.html",
        broadcast: "broadcast.html",
      },
    },
  },
});
