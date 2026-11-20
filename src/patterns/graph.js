/**
 * graph.js — live pattern flow diagram.
 *
 * Adapted from layaForWorkflows/web/graphs.js (same Cytoscape.js + dagre approach,
 * same palette-from-CSS-variables trick and visited/current/taken overlay idea),
 * extended so nodes can be added while a pattern runs (orchestrator workers,
 * hierarchical executors) and each node carries a live run state.
 */
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'

if (!cytoscape.__dagre) { cytoscape.use(dagre); cytoscape.__dagre = true }

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function palette() {
  return {
    bg: css('--bg'), card: css('--surface'), card2: css('--surface2'), line: css('--border'),
    ink: css('--text'), ink2: css('--text-muted'), accent: css('--accent'),
    llm: css('--exec'), tool: css('--info'), gate: css('--warn'), rule: '#e3b341',
    human: css('--allergy'), ok: css('--feedback'), bad: css('--danger'),
  }
}

// node kinds → shape + colour
const KIND = {
  input:  { shape: 'round-rectangle', color: 'accent', w: 150, h: 38 },
  llm:    { shape: 'round-rectangle', color: 'llm',    w: 158, h: 46 },
  agent:  { shape: 'ellipse',         color: 'llm',    w: 128, h: 58 },
  tool:   { shape: 'round-rectangle', color: 'tool',   w: 158, h: 40 },
  gate:   { shape: 'diamond',         color: 'gate',   w: 132, h: 74 },
  rule:   { shape: 'hexagon',         color: 'rule',   w: 160, h: 56 },
  human:  { shape: 'octagon',         color: 'human',  w: 140, h: 60 },
  output: { shape: 'round-rectangle', color: 'ok',     w: 150, h: 38 },
}

function style(P) {
  const kindStyles = Object.entries(KIND).map(([k, v]) => ({
    selector: `node.${k}`,
    style: { shape: v.shape, width: v.w, height: v.h, 'border-color': P[v.color], 'background-color': P.card },
  }))
  return [
    { selector: 'node', style: {
      label: 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 132, 'font-size': 10.5, color: P.ink,
      'text-valign': 'center', 'text-halign': 'center', 'border-width': 2, 'font-family': 'system-ui, sans-serif',
      'transition-property': 'opacity, border-width, background-color, underlay-opacity', 'transition-duration': '220ms', opacity: 0.55 } },
    ...kindStyles,
    { selector: 'node.gate', style: { 'text-max-width': 92, 'font-size': 9.5 } },
    { selector: 'edge', style: {
      width: 1.6, 'line-color': P.line, 'target-arrow-color': P.line, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
      'curve-style': 'bezier', label: 'data(label)', 'font-size': 9.5, color: P.ink2,
      'text-background-color': P.bg, 'text-background-opacity': 0.92, 'text-background-padding': 2, 'text-rotation': 'none',
      'transition-property': 'line-color, width, opacity', 'transition-duration': '220ms', opacity: 0.6 } },
    { selector: 'edge.loop', style: { 'line-style': 'dashed' } },
    // live run states
    { selector: 'node.queued',  style: { opacity: 0.85, 'border-style': 'dashed' } },
    { selector: 'node.running', style: { opacity: 1, 'border-width': 4, 'underlay-color': P.accent, 'underlay-opacity': 0.32, 'underlay-padding': 9, 'background-color': P.card2 } },
    { selector: 'node.done',    style: { opacity: 1, 'border-width': 3, 'background-color': P.card2 } },
    { selector: 'node.pass',    style: { opacity: 1, 'border-width': 3.5, 'border-color': P.ok, 'underlay-color': P.ok, 'underlay-opacity': 0.16, 'underlay-padding': 5 } },
    { selector: 'node.fail',    style: { opacity: 1, 'border-width': 3.5, 'border-color': P.bad, 'underlay-color': P.bad, 'underlay-opacity': 0.2, 'underlay-padding': 5 } },
    { selector: 'node.waiting', style: { opacity: 1, 'border-width': 4, 'underlay-color': P.human, 'underlay-opacity': 0.35, 'underlay-padding': 10 } },
    { selector: 'edge.taken',   style: { width: 3.5, opacity: 1, 'line-color': P.accent, 'target-arrow-color': P.accent, color: P.ink, 'font-weight': 700, 'z-index': 10 } },
    { selector: 'edge.taken.bad', style: { 'line-color': P.bad, 'target-arrow-color': P.bad } },
  ]
}

const STATES = 'queued running done pass fail waiting'

export function createGraph(container) {
  let cy = null
  let rankDir = 'LR'
  const counts = {}   // edge traversal counts for loop labels

  function layout(animate = false) {
    cy.layout({ name: 'dagre', rankDir, nodeSep: 26, rankSep: rankDir === 'LR' ? 54 : 40, edgeSep: 10, animate, animationDuration: 250, fit: true, padding: 18 }).run()
  }

  function edgeEls(edges) {
    return edges.map(([s, t, label = '', cls = '']) => ({ data: { id: `${s}->${t}`, source: s, target: t, label, base: label }, classes: cls }))
  }

  return {
    /** Draw a pattern's static flow. spec = { nodes:[{id,label,kind}], edges:[[s,t,label,cls]], rankDir } */
    reset(spec) {
      Object.keys(counts).forEach(k => delete counts[k])
      rankDir = spec.rankDir || 'LR'
      const els = [
        ...spec.nodes.map(n => ({ data: { id: n.id, label: n.label, base: n.label }, classes: n.kind })),
        ...edgeEls(spec.edges),
      ]
      if (cy) cy.destroy()
      cy = cytoscape({ container, elements: els, style: style(palette()), wheelSensitivity: 0.25, minZoom: 0.25, maxZoom: 2, boxSelectionEnabled: false, userPanningEnabled: true })
      layout()
    },
    /** Clear run state but keep the drawing. */
    clear() {
      if (!cy) return
      Object.keys(counts).forEach(k => delete counts[k])
      cy.batch(() => {
        cy.elements().removeClass(`${STATES} taken bad`)
        cy.elements().forEach(el => { if (el.data('base') !== undefined) el.data('label', el.data('base')) })
      })
    },
    /** Set a node's live state (and optionally a second label line). */
    set(id, state, sub) {
      const n = cy?.$id(id)
      if (!n || n.empty()) return
      n.removeClass(STATES)
      if (state) n.addClass(state)
      if (sub !== undefined) n.data('label', sub ? `${n.data('base')}\n${sub}` : n.data('base'))
    },
    /** Light up an edge; repeated traversals show a ×N counter (loops). */
    take(s, t, bad = false) {
      const e = cy?.$id(`${s}->${t}`)
      if (!e || e.empty()) return
      counts[e.id()] = (counts[e.id()] || 0) + 1
      e.addClass('taken'); if (bad) e.addClass('bad'); else e.removeClass('bad')
      const c = counts[e.id()]
      if (c > 1) e.data('label', `${e.data('base') ? e.data('base') + ' ' : ''}×${c}`)
    },
    /** Add nodes/edges discovered at runtime (orchestrator workers, executors) and re-layout. */
    add(nodes = [], edges = []) {
      if (!cy) return
      cy.add([
        ...nodes.filter(n => cy.$id(n.id).empty()).map(n => ({ data: { id: n.id, label: n.label, base: n.label }, classes: n.kind })),
        ...edgeEls(edges).filter(e => cy.$id(e.data.id).empty()),
      ])
      layout(true)
    },
    fit() { cy?.fit(undefined, 18) },
  }
}
