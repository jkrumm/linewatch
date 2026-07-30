import { Elysia } from 'elysia'
import { z } from 'zod'

const Schema = z.object({ a: z.number(), b: z.number() })

const app = new Elysia()
  .onError(({ error, code }) => { console.log('onError code=', code, String(error).slice(0, 200)) })
  .get('/t', () => ({ a: 1, b: null }) as unknown as { a: number; b: number }, { response: Schema })

const res = await app.handle(new Request('http://localhost/t'))
console.log('status', res.status)
console.log('body', await res.text())
