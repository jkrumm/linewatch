import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { NavLink as MantineNavLink } from '@mantine/core'
import { BasaltShell, ThemeToggle } from 'basalt-ui'
import type { NavLinkRenderer, SidebarSection } from 'basalt-ui'
import { useBasaltNav } from 'basalt-ui/router-tanstack'
import { IconActivity, IconAlertTriangle, IconChartLine, IconGauge } from '@tabler/icons-react'
import { useCallback } from 'react'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
})

const ICON = 18

function RootLayout() {
  const { isActive } = useBasaltNav()

  const renderNavLink = useCallback<NavLinkRenderer>(
    (item, { active, navLinkClassName }) => {
      if (!item.href) return <MantineNavLink label={item.label} leftSection={item.icon} disabled />
      return (
        <MantineNavLink
          component={Link}
          // item.href is a plain runtime string (SidebarItem's shape), not one of the router's
          // typed literal route paths — the cast is the same escape hatch argo's dashboard uses
          // for the identical router-agnostic shell seam.
          to={item.href as never}
          label={item.label}
          leftSection={item.icon}
          active={active}
          className={navLinkClassName}
        />
      )
    },
    [],
  )

  const sections: SidebarSection[] = [
    {
      label: 'Line',
      items: [
        {
          key: 'now',
          label: 'Now',
          short: 'Now',
          mobile: true,
          icon: <IconActivity size={ICON} />,
          href: '/',
          active: isActive('/', { exact: true }),
        },
        {
          key: 'uptime',
          label: 'Uptime',
          short: 'Uptime',
          mobile: true,
          icon: <IconAlertTriangle size={ICON} />,
          href: '/uptime',
          active: isActive('/uptime'),
        },
        {
          key: 'latency',
          label: 'Latency',
          short: 'Latency',
          mobile: true,
          icon: <IconChartLine size={ICON} />,
          href: '/latency',
          active: isActive('/latency'),
        },
        {
          key: 'speed',
          label: 'Speed',
          short: 'Speed',
          mobile: true,
          icon: <IconGauge size={ICON} />,
          href: '/speed',
          active: isActive('/speed'),
        },
      ],
    },
  ]

  return (
    <BasaltShell
      brand={{ name: 'linewatch', version: __APP_VERSION__ }}
      sections={sections}
      renderNavLink={renderNavLink}
      globalActions={<ThemeToggle />}
    >
      <Outlet />
    </BasaltShell>
  )
}
