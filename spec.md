\# System Specification: Healthcare Agent Harness Demo (Etna Labs Framework)



\## Objective

Build a pure frontend, client-side Node.js application (compiled via Vite) that demonstrates the 3-layer "Harness Engineering" architecture (Information, Execution, Feedback) applied to a Healthcare Assistant. The application must deploy seamlessly onto GitHub Pages with zero server-side dependencies. All state, logs, and memories must persist in the browser's `localStorage`.



\---



\## Architectural Constraints (GitHub Pages Friendly)

1\. \*\*No Backend Server:\*\* No Express, no Node.js execution at runtime, no server-side databases.

2\. \*\*Node.js Tooling only for Build:\*\* Use Vite for development and bundling static assets.

3\. \*\*Browser Storage as DB:\*\* Use `localStorage` to mock databases, memory, and vector-like keyword retrievals.

4\. \*\*Client-Side API Calls:\*\* Direct `fetch` streams or SDK calls to OpenAI/Anthropic/Ollama endpoints. The UI must include a settings panel for the user to securely input and store their own API Key in session memory so no keys are hardcoded.



\---



\## Folder Structure to Generate

```text

src/

├── main.js                # UI State, DOM Manipulation, and Layout

├── index.html             # Single Page Application entry point

├── styles.css             # Scannable, clean, dashboard-like styling

├── information/

│   ├── memoryManager.js   # Layer 1: LocalStorage interaction \& retrieval

│   └── tools.js           # Layer 1: Core healthcare utility tools

├── execution/

│   ├── orchestrator.js    # Layer 2: State machine loop \& agent reasoning

│   └── guardrails.js      # Layer 2: Safety \& policy validation rules

└── feedback/

&#x20;   ├── verification.js    # Layer 3: Automated output testing

&#x20;   └── tracer.js          # Layer 3: Event stream \& log tracking



Component Specifications1. Information Layer (src/information/)tools.js: Export standard JavaScript functions packaged with JSON Schema metadata (simulating Function Calling structures).checkDrugInteraction(med1, med2): Looks up a hardcoded dictionary of 5–10 common drugs. (e.g., Blood Thinner + Aspirin = High Bleeding Risk warning).fetchPatientVitals(patientId): Returns a mock patient history with vitals.calculateDosage(mgPerKg, weightKg): Calculates absolute safe drug dosage thresholds.memoryManager.js:Implements a simple keyword-matching retrieval system against localStorage keys ('healthcare\_harness\_memories').When given a task, it scans the text for keywords (e.g., "diabetes", "elderly") and pulls past failure logs or clinician corrections tagged with those keywords to prepend to the system prompt context.2. Execution Layer (src/execution/)orchestrator.js:Implements the core Agentic Loop: Plan $\\rightarrow$ Tool Call $\\rightarrow$ Parse $\\rightarrow$ Retry/Complete.Uses Progressive Disclosure: Instead of dumping the entire history, it queries the LLM to choose which tool to call first based on the primary complaint.Constructs the full system instructions containing: Base persona, retrieved memory traces from Layer 1, and output constraints (demanding a structured JSON response layout).guardrails.js:Acts as an automated interceptor. It reviews the raw tool requests or text output before final rendering.Hard Rule: If the agent recommends a dosage over the absolute calculated threshold from tools.js, or flags a fatal interaction, the guardrail rejects the step, appends a system error, and forces orchestrator.js to run a corrective iteration loop.3. Feedback Layer (src/feedback/)verification.js:Evaluates final outputs using strict structural schemas (e.g., checking if the prescription JSON contains a valid reason, duration, and doctor-review flag).tracer.js:A publisher-subscriber module that logs exactly what happens across every layer and posts it visually to the UI.Human-In-The-Loop (HITL) Capture:The app must provide a "Clinician Review Portal" UI. When the agent yields a care plan, it stands "Pending Approval".If a user clicks \[Approve], it marks the trajectory as a success score ($1.0$).If a user clicks \[Reject \& Correct], an input box opens: "What did the agent miss?". The text provided by the user is structured into a correction object and pushed into memoryManager.js to optimize the next execution loop.Frontend User Interface RequirementsDesign a modern, dashboard-style UI divided cleanly into columns or quadrants to show the harness at work:Configuration Banner: Input field for API Token, selector for model endpoint, and a "Reset Local Memory" button.Left Column (Input \& Actions): Dropdown to select mock patient scenarios (e.g., "Scenario A: Elderly patient with high blood pressure asking for cold meds") and a big \[Execute Agent] button.Center Column (The Live Harness Trace): A clean terminal-like view showcasing real-time processing color-coded by the active layer:\[INFO LAYER] Searching past feedback logs... Found 1 relevant nurse correction.\[EXECUTION LAYER] Invoking checkDrugInteraction()... Warning caught.\[FEEDBACK LAYER] Verifying schema... Passed automated clinical audit.Right Column (The Clinician Desk): Displays the output care plan with explicit \[Approve Plan] and \[Reject \& Adjust] workflows to feed back into Layer 3.Build and Deployment SpecificationConfigure standard Vite deployment parameters:Include a vite.config.js specifying the base: './' or base: '/repo-name/' property.Provide a standard package.json utilizing the gh-pages npm package with the deployment lifecycle hooks:JSON"scripts": {

&#x20; "dev": "vite",

&#x20; "build": "vite build",

&#x20; "predeploy": "npm run build",

&#x20; "deploy": "gh-pages -d dist"

}



