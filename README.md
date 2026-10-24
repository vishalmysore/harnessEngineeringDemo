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
📸 Screenshot walkthrough of the live demo: [article_harness_walkthrough.md](./article_harness_walkthrough.md)
🔁 Loop Engineering page and its article: [article_loop_engineering.md](./article_loop_engineering.md)

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
- **Local LLM in the browser** — WebLLM on WebGPU (Llama 3.2, Phi-3.5, Qwen 2.5, Gemma 2); no API key, no backend
- **Human-in-the-loop** — Approve or Reject & Correct every recommendation; corrections are stored in memory and injected into future runs
- **Live harness trace** — real-time event stream color-coded by layer (Info / Execution / Feedback / Guardrail)
- **Persistent memory** — clinician/reviewer corrections stored in localStorage, retrieved by keyword matching within the same domain

---

## Quick Start

```bash
git clone https://github.com/vishalmysore/harnessEngineeringDemo.git
cd harnessEngineeringDemo
npm install
npm run dev
```

Open http://localhost:5173 and either click **Load Model** (needs a WebGPU browser) or tick **Mock mode** to run the real tools and guardrails without a GPU.

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
    └── llm.js             # WebLLM wrapper with prompt-based tool calling
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

## Local Models

| Model | Download |
|-------|----------|
| Llama 3.2 3B (recommended) | ~2.0 GB |
| Llama 3.2 3B f32 (Intel / integrated GPUs, where f16 builds can produce garbled text) | ~2.9 GB |
| Phi-3.5 Mini | ~2.2 GB |
| Qwen 2.5 3B | ~2.0 GB |
| Gemma 2 2B | ~1.5 GB |
| Llama 3.2 1B (fast) | ~0.9 GB |

Models download once, are cached by the browser, and run on your GPU through WebGPU. Nothing leaves the tab.

**"WebGPU is supported, but the browser would not give this page a GPU"?** Turn on *Use graphics acceleration when available* in your browser settings and restart, then check that `chrome://gpu` lists WebGPU as hardware accelerated (some GPU drivers are blocked). Mock mode works on any machine.

---

## Credits

- The three-layer harness architecture (Information · Execution · Feedback) follows **Etna Labs**.
- In-browser inference by [WebLLM](https://github.com/mlc-ai/web-llm) (MLC AI) with Meta's Llama 3.2 and other open models.
- Research references are listed in [article.md](./article.md#references).

---

## Disclaimer

This is an educational demo, provided as is with no warranty. All patients, claims, policies, applicants, compounds, scores and thresholds are **fictional** and simplified. Nothing here is medical, pharmaceutical, insurance, financial, legal, career or regulatory advice, and it must not be used to make real decisions. AI output can be wrong, and the guardrails catch some errors but not all. This is an independent personal project; names of companies, labs, frameworks and models are used only for credit or description and do not imply endorsement or affiliation.

---

## Related

- [ReasoningBank Demo](https://github.com/vishalmysore/reasoningBankDemo) — AI travel agent that learns from every trip using a ReasoningBank-style memory system
