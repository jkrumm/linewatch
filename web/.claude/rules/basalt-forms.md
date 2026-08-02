---
source: basalt-ui
description: Mantine form conventions for basalt-ui apps — useBasaltForm, field, FormErrorSummary, useFormDraft from the shipped ./forms battery. @mantine/form is an optional peer.
paths:
  - 'src/**'
  - 'apps/**/src/**'
---

# Basalt Forms

basalt-ui ships `./forms` — a Mantine form adapter battery providing `useBasaltForm`, `field`,
`FormErrorSummary`, and `useFormDraft` on top of `@mantine/form`. `@mantine/form` is an **optional
peer** — install it explicitly before using this battery:

```bash
bun add @mantine/form
```

Valibot is the default validation library (install it too: `bun add valibot`). Zod 4 works if
already standardised in the project.

## useBasaltForm

`useBasaltForm` is a typed `useForm` wrapper that applies basalt defaults — `mode: 'uncontrolled'`
and `schemaResolver(schema, { sync: true })` when a schema is provided.

```ts
import * as v from 'valibot'
import { useBasaltForm, field } from 'basalt-ui/forms'
import { TextInput, NumberInput, Button } from '@mantine/core'

const Schema = v.object({
  name: v.pipe(v.string(), v.minLength(2, 'Name must be at least 2 characters')),
  email: v.pipe(v.string(), v.email('Enter a valid email')),
  amount: v.pipe(v.number(), v.minValue(0, 'Amount must be non-negative')),
})
type Values = v.InferOutput<typeof Schema>
const INITIAL: Values = { name: '', email: '', amount: 0 }

function MyForm() {
  const form = useBasaltForm({ initialValues: INITIAL, schema: Schema })

  return (
    <form onSubmit={form.onSubmit((values) => console.log(values))}>
      <TextInput {...field(form, 'name')} label="Name" />
      <TextInput {...field(form, 'email')} label="Email" />
      <NumberInput {...field(form, 'amount')} label="Amount" />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

- **`mode: 'uncontrolled'`** is the default — avoids per-keystroke re-renders. Pass
  `mode: 'controlled'` if real-time derived state is needed.
- **Schema param** types against `StandardSchemaV1` from `basalt-ui` (vendored spec, not a package).
  A real Valibot or Zod 4 schema is structurally assignable — no wrapper needed.
- **`{ sync: true }`** keeps `form.validate()` / `form.isValid()` synchronous for sync schemas.
  Omit only when the schema has async refinements.

## field

`field(form, path)` bundles `getInputProps(path)` + `key(path)` into one spread — the two things
every Mantine v9 uncontrolled field requires:

```ts
<TextInput {...field(form, 'email')} label="Email" />
// equivalent to:
<TextInput {...form.getInputProps('email')} key={form.key('email')} label="Email" />
```

## schemaResolver options

- **`{ sync: true }`** — required for sync schemas (Zod 4, Valibot, ArkType). Keeps
  `form.validate()` and `form.isValid()` synchronous.
- **Zod 4** — `import { z } from 'zod'`. Zod 4's root export implements Standard Schema natively.
- **Valibot** — `import * as v from 'valibot'`. No separate resolver needed; the object schema
  is directly assignable to `StandardSchemaV1`.
- **ArkType**, **Effect/Schema** — also implement Standard Schema natively.
- Type schema params against `StandardSchemaV1` from `basalt-ui` (never `ZodSchema`).

## FormErrorSummary

An accessible error-summary component for long forms and screen readers. Renders a Mantine `Alert`
with `role="alert"` listing all field errors. Returns `null` when the form is clean.

```tsx
import { FormErrorSummary } from 'basalt-ui/forms'

// Place at the top of the form so screen readers announce errors on submit:
;<form onSubmit={form.onSubmit(handleSubmit)}>
  <FormErrorSummary form={form} title="Fix these before submitting" />
  {/* fields */}
</form>
```

- Place at the **top of the form** so AT focus moves to the summary on submit failure.
- `title` defaults to `"Please fix the following errors"`.
- Renders `null` (no DOM node) when `form.errors` is empty — safe to include unconditionally.

## useFormDraft

`useFormDraft` persists form values to `localStorage` via `createPersistedState` (versioned,
SSR-safe, cross-tab). It restores the draft on mount and exposes `clearDraft` + `saveDraft`.

```ts
import { useBasaltForm, field, FormErrorSummary, useFormDraft } from 'basalt-ui/forms'
import { Button, TextInput } from '@mantine/core'

const INITIAL: Values = { name: '', email: '' }

function EditForm() {
  const { clearDraft, saveDraft } = useFormDraft(form, { key: 'edit-form', version: 1 })

  // Wire saveDraft into useBasaltForm's onValuesChange for automatic autosave:
  const form = useBasaltForm({
    initialValues: INITIAL,
    schema: Schema,
    onValuesChange: saveDraft,    // ← automatic autosave on every field change
  })

  return (
    <form
      onSubmit={form.onSubmit((values) => {
        submit(values)
        clearDraft()              // ← clear on success
      })}
    >
      <FormErrorSummary form={form} />
      <TextInput {...field(form, 'name')} label="Name" />
      <Button type="submit">Submit</Button>
      <Button variant="subtle" onClick={clearDraft}>Discard draft</Button>
    </form>
  )
}
```

### Autosave mechanism

`@mantine/form` v9 has no built-in whole-form change subscription on an existing form instance —
`form.watch` is per-field only. The correct autosave paths are:

1. **`useBasaltForm({ onValuesChange: saveDraft })`** (recommended) — `onValuesChange` fires on every
   value change with `(values, previous)`. Pass `saveDraft` directly (it snapshots `form.getValues()`
   internally).
2. **`<TextInput {...field(form, 'name')} onBlur={saveDraft} />`** — explicit blur-based autosave.
   Use this for externally-created forms or when keystroke-level persistence is too aggressive.

### Key must be stable

The `key` option must not change between renders. Changing it recreates the storage instance and
loses the current draft. Use a module-level constant or a prop passed down from the route.

### Version bump

Increment `version` when the form values shape changes (added/removed fields, renamed keys). The
draft is automatically discarded and falls back to `initialValues` — no migration needed for simple
shape changes.

### clearDraft on success

Always call `clearDraft()` in `onSubmit`'s success path so stale form data doesn't reappear after
a successful save:

```ts
form.onSubmit(async (values) => {
  await mutation.mutateAsync(values)
  clearDraft()
})
```

## List helpers

For dynamic lists: `form.insertListItem('items', {...})` / `form.removeListItem('items', index)`.
Access via `form.getValues().items[index]` (uncontrolled) and bind with
`form.getInputProps('items.0.field')` / `field(form, 'items.0.field')`.

## Submission

```ts
form.onSubmit((values) => mutation.mutate(values))
```

Reset after success with `form.reset()` — never mutate `form.values` directly. Surface validation
as inline field errors via `getInputProps`; toast only on submit-level failures.
See basalt-query.md for the mutation/invalidation pattern.
