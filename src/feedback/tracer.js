const listeners = {}
const logs = []

const tracer = {
  subscribe(event, callback) {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(callback)
    return () => {
      listeners[event] = listeners[event].filter(cb => cb !== callback)
    }
  },

  publish(event, data) {
    const entry = { event, data, timestamp: new Date().toISOString() }
    logs.push(entry)
    ;(listeners[event] || []).forEach(cb => cb(data, entry))
    ;(listeners['*'] || []).forEach(cb => cb(event, data, entry))
  },

  getLogs() {
    return [...logs]
  },

  clearLogs() {
    logs.length = 0
  }
}

export default tracer
