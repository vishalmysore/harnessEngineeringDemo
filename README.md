# Harness Engineering Demo

> **The model is the brain. The harness is the hands.**

A browser-native demonstration of the **3-layer Agent Harness architecture** applied across four real domains — Healthcare, Insurance, Career Counselling, and Drug Discovery. No backend. No database. Runs entirely in the browser and deploys to GitHub Pages.

🔗 **Live Demo:** https://vishalmysore.github.io/harnessEngineeringDemo/

---

## What is Harness Engineering?

Harness Engineering treats the code *surrounding* a Large Language Model — the prompt wrappers, memory modules, tool registries, execution loops, and guardrail systems — as a **primary engineering abstraction** that co-determines agent performance just as much as the model itself.

The three layers:

| Layer | Responsibility |
|-------|---------------|
| **1 · Information** | Memory retrieval, tool schemas, context assembly, progressive disclosure |
| **2 · Execution** | Agentic loop (Plan → Tool Call → Guardrail → Retry/Complete), multi-turn tool use |
| **3 · Feedback** | Schema verification, human-in-the-loop capture, corrections fed back into memory |

📄 Read the full article: [article.md](./article.md)

---

## Domains

Each domain is a self-contained module with its own tools, scenarios, guardrails, and mock simulation. The orchestrator is fully domain-agnostic.

| Domain | Icon | Tools | Key Guardrails |
|--------|------|-------|----------------|
| **Healthcare** | ⚕ | Drug interactions, patient vitals, dosage calc | HIGH interaction block, allergy cross-check, dosage cap |
| **Insurance** | 🛡️ | Claim details, policy coverage, fraud scoring | Fraud ≥ 0.7 → SIU referral block, coverage limit exceeded |
| **Career Counselling** | 🎓 | Applicant profile, job market, skill gap | Age-neutral guardrail, low demand warning, timeline realism |
| **Drug Discovery** | 🔬 | Compound profile, toxicology, regulatory pathway | Hepatotox ≥ 0.7 → IND blocked, Ames positive → blocked, hERG cardiac flag |

---

## Features

- **Mock AI mode** — runs the full tool-calling and guardrail loop with zero network calls; every guardrail activation is real logic, not simulated output
- **Multi-provider LLM support** — OpenAI, Anthropic, Google Gemini, NVIDIA NIM (Nemotron Nano 12B V2)
- **CORS proxy routing** — all API calls routed via configurable proxy using `x-target-url` header
- **Human-in-the-loop** — Approve or Reject & Correct every recommendation; corrections are stored in memory and injected into future runs
- **Live harness trace** — real-time event stream color-coded by layer (Info / Execution / Feedback / Guardrail)
- **Persistent memory** — clinician/reviewer corrections stored in localStorage, retrieved by keyword matching

---

## Quick Start

```bash
git clone https://github.com/vishalmysore/harnessEngineeringDemo.git
cd harnessEngineeringDemo
npm install
npm run dev
```

Open http://localhost:5173 — select **Mock AI** as the provider to run without an API key.

---

## Project Structure

```
src/
├── domains/
│   ├── healthcare.js      # ⚕ Healthcare domain
│   ├── insurance.js       # 🛡️ Insurance domain
│   ├── career.js          # 🎓 Career Counselling domain
│   ├── drugDiscovery.js   # 🔬 Drug Discovery domain
│   └── index.js           # Domain registry
├── execution/
│   ├── orchestrator.js    # Domain-agnostic agentic loop
│   └── guardrails.js      # Healthcare guardrail validators
├── information/
│   ├── tools.js           # Healthcare tool functions + JSON schemas
│   └── memoryManager.js   # Keyword-matched memory retrieval
├── feedback/
│   ├── verification.js    # Schema validation
│   └── tracer.js          # Pub/sub event stream
└── utils/
    └── llm.js             # Multi-provider LLM calls via CORS proxy
```

---

## Scripts

```bash
npm run dev      # Start dev server at http://localhost:5173
npm run build    # Production build → /dist
npm run preview  # Preview production build locally
```

Deployment to GitHub Pages is handled automatically via `.github/workflows/deploy.yml` on every push to `main`.

---

## LLM Providers

| Provider | Models | Key |
|----------|--------|-----|
| OpenAI | GPT-4o, GPT-4o Mini | `sk-…` |
| Anthropic | Claude Opus 4.7, Sonnet 4.6 | `sk-ant-…` |
| Google Gemini | Gemini 2.0 Flash, 1.5 Pro | `AIza…` |
| NVIDIA NIM | Nemotron Nano 12B V2, Llama 3.1 70B | `nvapi-…` |
| Mock AI | No key required | — |

API keys are stored in session memory only — never sent anywhere except the LLM provider via the CORS proxy.

---

## Related

- [ReasoningBank Demo](https://github.com/vishalmysore/reasoningBankDemo) — AI travel agent that learns from every trip using a ReasoningBank-style memory system
