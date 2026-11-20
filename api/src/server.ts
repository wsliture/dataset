import { createApp } from './app.js'
import { configFrom } from './config.js'

const config = configFrom()
const app = await createApp(config)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close() })
}
try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  app.log.error(error)
  await app.close()
  process.exitCode = 1
}
