import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { readAppConfig, assertPublishable } from './src/config.js'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command, mode }) => {
  const config = readAppConfig(loadEnv(mode, process.cwd(), 'VITE_'))
  if (command === 'build') assertPublishable(config)
  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true
        }
      }
    }
  }
})
