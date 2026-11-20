import { defineConfig } from 'vite'

export default defineConfig({
  server: { proxy: { '/api': process.env.DATASET_API_ORIGIN ?? 'http://127.0.0.1:4190' } },
  preview: { proxy: { '/api': process.env.DATASET_API_ORIGIN ?? 'http://127.0.0.1:4190' } },
})
