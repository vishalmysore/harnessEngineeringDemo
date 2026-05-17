const STORAGE_KEY = 'healthcare_harness_memories'

function loadMemories() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveMemories(memories) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(memories))
}

export function saveCorrection(correction) {
  const memories = loadMemories()
  memories.push({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    text: correction.text,
    tags: correction.tags || [],
    scenario: correction.scenario || 'unknown',
    type: 'clinician_correction'
  })
  saveMemories(memories)
}

export function retrieveRelevantMemories(taskText) {
  const memories = loadMemories()
  if (!memories.length) return []
  const words = taskText.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  return memories.filter(mem => {
    const haystack = (mem.text + ' ' + mem.tags.join(' ')).toLowerCase()
    return words.some(word => haystack.includes(word))
  })
}

export function getAllMemories() {
  return loadMemories()
}

export function clearAllMemories() {
  localStorage.removeItem(STORAGE_KEY)
}
