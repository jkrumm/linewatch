import { createBasaltRouter } from 'basalt-ui'
import { routeTree } from '../routeTree.gen'

// basalt's QueryClient defaults already carry the 30 s `staleTime` and no refetch on window focus;
// `defaultPreload: 'intent'` and `defaultPreloadStaleTime: 0` are `createBasaltRouter`'s too.
export const router = createBasaltRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
