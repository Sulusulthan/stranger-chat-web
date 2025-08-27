import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('livekit')) return 'livekit'
            if (id.includes('react') || id.includes('react-dom')) return 'react-vendor'
            return 'vendor'
          }
        }
      }
    }
  }
})
