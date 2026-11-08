import { describe, expect, test } from 'bun:test'
import { loadState } from './query-state'

const WAITING = { data: undefined, isError: false, error: null }
const LOADED = { data: [], isError: false, error: null }
const FAILED = { data: undefined, isError: true, error: new Error('boom') }
const REFRESH_FAILED = { data: [], isError: true, error: new Error('later') }

describe('loadState', () => {
  test('an unanswered query is pending, not failed', () => {
    expect(loadState([WAITING])).toEqual({ pending: true, error: undefined })
  })

  test('a rejected query with nothing to show is an error, never pending', () => {
    const state = loadState([FAILED])
    expect(state.pending).toBe(false)
    expect(state.error).toBeInstanceOf(Error)
  })

  test('one failure outranks sibling queries still loading', () => {
    expect(loadState([WAITING, FAILED]).pending).toBe(false)
  })

  test('a failed refetch that still holds data is neither pending nor an error', () => {
    expect(loadState([REFRESH_FAILED])).toEqual({ pending: false, error: undefined })
  })

  test('everything loaded is neither', () => {
    expect(loadState([LOADED, LOADED])).toEqual({ pending: false, error: undefined })
  })
})
