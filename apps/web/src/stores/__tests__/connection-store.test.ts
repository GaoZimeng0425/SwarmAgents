import { eventEmitter } from '../connection-store'

describe('eventEmitter', () => {
  it('delivers events to specific subscribers', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('entry_appended', (data) => received.push(data))

    eventEmitter.emit('entry_appended', { sessionId: 's1', rowId: 1 })
    eventEmitter.emit('tool_execution_update', { toolCallId: 't1' })

    expect(received).toEqual([{ sessionId: 's1', rowId: 1 }])
    unsub()
  })

  it('delivers all events to wildcard subscribers as { event, data }', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('*', (data) => received.push(data))

    eventEmitter.emit('entry_appended', { a: 1 })
    eventEmitter.emit('session.updated', { b: 2 })

    expect(received).toEqual([
      { event: 'entry_appended', data: { a: 1 } },
      { event: 'session.updated', data: { b: 2 } },
    ])
    unsub()
  })

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('entry_appended', (data) => received.push(data))

    eventEmitter.emit('entry_appended', { first: true })
    unsub()
    eventEmitter.emit('entry_appended', { second: true })

    expect(received).toEqual([{ first: true }])
  })
})
