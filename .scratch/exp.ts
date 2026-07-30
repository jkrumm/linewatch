import { Elysia } from 'elysia'
import { z } from 'zod'

const Schema = z.object({ a: z.number(), nested: z.object({ x: z.number() }) })

const app = new Elysia().get('/t', () => ({ a: 1, extra: 42, nested: { x: 1, y: 2 } }), { response: Schema })

const res = await app.handle(new Request('http://localhost/t'))
console.log('status', res.status)
console.log('body', await res.text())
