import { createBasaltQueryClient } from 'basalt-ui/query'

export const queryClient = createBasaltQueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})
