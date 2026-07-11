// We test the event emitter directly since it's the backbone of useEvents.
import { eventEmitter } from '@/stores/connection-store'

describe('eventEmitter', () => {
  it('delivers events to specific subscribers', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('message.created', (data) => received.push(data))

    eventEmitter.emit('message.created', { sessionId: 's1', messageId: 'm1' })
    eventEmitter.emit('message.progress', { event: 'thinking' })

    expect(received).toEqual([{ sessionId: 's1', messageId: 'm1' }])
    unsub()
  })

  it('delivers all events to wildcard subscribers', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('*', (data) => received.push(data))

    eventEmitter.emit('message.created', { a: 1 })
    eventEmitter.emit('session.updated', { b: 2 })

    expect(received).toEqual([
      { event: 'message.created', data: { a: 1 } },
      { event: 'session.updated', data: { b: 2 } },
    ])
    unsub()
  })

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('message.created', (data) => received.push(data))

    eventEmitter.emit('message.created', { first: true })
    unsub()
    eventEmitter.emit('message.created', { second: true })

    expect(received).toEqual([{ first: true }])
  })
})
