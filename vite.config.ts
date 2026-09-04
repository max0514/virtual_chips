import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: vite serves the client on 5174 and proxies the websocket to the
// game server on 8787. Production: `npm run build` emits web/ and the
// game server serves it itself, so there is only ever one port to expose.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'build/web', emptyOutDir: true },
  server: {
    port: 5174,
    host: true, // bind 0.0.0.0 so phones on the same wifi can reach the dev server
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
