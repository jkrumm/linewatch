import '@mantine/core/styles.layer.css'
import 'basalt-ui/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BasaltProvider, createBasaltTheme } from 'basalt-ui'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { queryClient } from './lib/query-client'
import { router } from './lib/router'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <BasaltProvider theme={createBasaltTheme()} defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </BasaltProvider>
  </StrictMode>,
)
