/**
 * WORKAROUND — basalt-ui 1.32.0's MIGRATING recipe imports `CONTAINER_CLASSES` from
 * `basalt-ui/tokens`, but no public entry exports it (it lives in `dist/tokens/size-classes.js`,
 * which the package's `exports` map does not reach). Mirrored here so the container grids key on
 * the same four boundaries the `basalt/raw-breakpoint` rule and `check-theme` accept. Delete and
 * import from `basalt-ui/tokens` once it is exported there.
 */
export const CONTAINER_CLASSES = { micro: 0, compact: 240, regular: 480, wide: 800 } as const
