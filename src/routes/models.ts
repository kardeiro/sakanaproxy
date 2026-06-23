import { Hono } from 'hono'
import { listRegisteredModels } from '../core/model-registry.js'
import { cache } from '../cache/memory-cache.js'

const app = new Hono()

app.get('/v1/models', async (c) => {
  const cacheKey = 'models:list'
  const cached = await cache.get<any>(cacheKey)
  if (cached) return c.json(cached)

  const models = listRegisteredModels()
  const formatted = {
    object: 'list',
    data: models,
  }
  await cache.set(cacheKey, formatted, 300)
  return c.json(formatted)
})

app.get('/v1/models/:model', async (c) => {
  const modelId = c.req.param('model')
  const models = listRegisteredModels()
  const model = models.find(m => m.id === modelId)
  if (!model) {
    return c.json({ error: 'Model not found' }, 404)
  }
  return c.json(model)
})

export { app }
