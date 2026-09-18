import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Let the client reach the realtime server in dev without CORS/setup.
      '/boardquest-ws': {
        target: 'ws://localhost:8787',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
})
