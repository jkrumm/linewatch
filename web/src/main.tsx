import 'basalt-ui/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BasaltProvider } from 'basalt-ui'
import { router } from './lib/router'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <BasaltProvider router={router} />
  </StrictMode>,
)
