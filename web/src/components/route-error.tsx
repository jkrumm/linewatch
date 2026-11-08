import type { ErrorComponentProps } from '@tanstack/react-router'
import { Button, Stack } from '@mantine/core'
import { QueryError } from './query-error'

/**
 * The router's error screen: a render or loader failure that no section handles. A rejected query
 * never reaches it (the loader prefetches without throwing and each section draws its own error),
 * so what lands here is a genuine defect — still worth a way back that is not a hard reload.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <Stack gap="md" py="xl">
      <QueryError what="the dashboard" error={error} />
      <Button variant="default" onClick={reset} style={{ alignSelf: 'flex-start' }}>
        Try again
      </Button>
    </Stack>
  )
}
