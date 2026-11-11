import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the browser talks to Vite (port 5173), and Vite forwards
// anything under /api to the Express API. Same origin for the browser, so no
// CORS setup is needed. In production Express serves the built files itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:4000' },
  },
});
