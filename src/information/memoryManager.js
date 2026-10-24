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
    domain: correction.domain || null,
    type: 'clinician_correction'
  })
  saveMemories(memories)
}

// Filler words that would otherwise match almost any correction
const STOPWORDS = new Set(['with', 'that', 'this', 'from', 'have', 'been', 'into', 'than', 'then', 'they', 'were', 'will', 'what', 'when', 'your', 'their', 'there', 'which', 'about', 'after', 'before', 'needs', 'requesting'])

// domainId scopes retrieval so one domain's corrections never steer another;
// legacy entries saved without a domain still match everywhere.
export function retrieveRelevantMemories(taskText, domainId) {
  const memories = loadMemories()
    .filter(mem => !domainId || !mem.domain || mem.domain === domainId)
  if (!memories.length) return []
  const words = taskText.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOPWORDS.has(w))
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
