import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { BasaltRouterContext } from 'basalt-ui'
import { Box, Container } from '@mantine/core'
import classes from '../shell/root-layout.module.css'

/**
 * No shell.
 *
 * There was a `BasaltShell` here — a sidebar, a brand block, five nav links and a mobile bar —
 * wrapped around a router that now has exactly one route. The five links pointed at Uptime,
 * Latency, Speed and Vantage pages whose entire content is on the dashboard, each section already
 * scoped by the dashboard's own range control; navigating to one silently re-scoped the data under
 * the reader, which is why they were folded in. A navigation chrome for a single destination is
 * pure cost: on a 1440 px monitor the sidebar took 240 px of width from the charts, and on a phone
 * it added a bar over them.
 *
 * What the shell also provided — the theme toggle — moved next to the range control, where the
 * page's two other global controls are. That is where a reader looks for a control that changes
 * the whole page.
 *
 * So the root is a container and an outlet. `size={1600}` rather than a Mantine named size: the
 * charts are time series read across, and the wide ones (the availability strip, the 30-day
 * heatmap) get materially more resolution per hour at 1600 px than at `xl`'s 1320.
 *
 * The gutter is a class and NO `px` prop: it is stated once in `root-layout.module.css` on basalt's
 * own page-gutter tokens, which `page-bar.module.css` cancels by name rather than by a second copy
 * of the numbers. A `px={0}` here (which used to sit beside the class) is an inline style and beats
 * it — the page then has no gutter and the full-bleed bar overshoots the viewport by the inset.
 */
export const Route = createRootRouteWithContext<BasaltRouterContext>()({
  component: RootLayout,
})

function RootLayout() {
  return (
    <Box mih="100dvh">
      <Container size={1600} className={classes.page} pb="xl">
        <Outlet />
      </Container>
    </Box>
  )
}
