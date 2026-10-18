# AI "Stage 3" exercise

## Requirements

### 3 required artifacts

#### 1. The Prompt

A markdown file containing the practitioner's prompt or command.

a. Follows structured prompting (RTCC (Role Task Context Constraints) or similar)
b. Demonstrates deliberate instruction design.
c. **Load-Bearing Principle:** >=90% of instructions must be load-bearing (each instruction serves at least one evaluation criterion).
d. No dead weight or filler text.

#### 2. The Evaluations

Scripts, Promptfoo YAML configs, or documented test cases.

a. **>=3 distinct evaluation criteria** (not variations of the same check).
b. Substantive quality checks, not window dressing.
c. Capable of producing **95%+ scores** when the prompt performs well.
d. Runs on **mid-tier models or lower** (Sonnet, GPT-4) – no frontier model requirement.
e. Clear pass/fail thresholds or scoring rubrics.

#### 3. The Log

An iteration log showing evidence of prompt evolution.

a. **>=2 documented iterations** minimum.
b. Each iteration includes: baseline scores, hypothesis, change made, measured results, and reasoning.
c. Evidence of EDD discipline (Red/Green/Refactor cycle).
d. Chronological progression with cause-and-effect.

#### 4. Optional README file

Guide the external examination AI agent through file structure and evaluation instructions.

## Stage 3 description

### Wave 2: Process

AI reshapes how work gets done.

#### Stage 3: Task

You give Al a defined task with real context. You craft prompts deliberately, set constraints, and review output critically. You measure improvement from prompt changes with clear, repeatable answers.

**Example:** "Write unit tests for this service class following our naming conventions and error handling patterns."

**Counterfeit:** Without measurable evaluation, quality is subjective and feelings-based. You cannot tell improvement from drift.

**You have completed Stage 3 when you can produce:**

- **Evaluation Framework Documented**
  - A written rubric or scoring method you use to assess prompt/output quality, with at least 3 evaluation criteria defined.
- **Quantified Improvement Evidence**
  - Before/after metrics from a prompt change: accuracy gained (%), or error rate reduced (count).

---

Stage 3 exercise teaches us the importance of evaluations of our prompts, that we have to start with the end in mind, and be able to measurably assess the quality of outputs from those prompts. The critical question for Stage 3 is **"When you change a prompt, how do you know you made it better?"**.
We measure success of a single prompt, seeking something that is successful 95% of the time.

## Artifacts context

1. The prompt file is `tests/prompts/prompt-to-test.md`. For documentation and evidence purposes create copies named prompt-to-test-v1.md, prompt-to-test-v2.md, prompt-to-test-v3.md, etc. after each prompt improvement.
2. The evaluation results are stored at `tests/evaluations/results.json` and `tests/evaluations/results.html` by promptfoo itself. Similar to the prompt file, create versioned copies of the evaluation results. The evaluations run `tests/prompt-tests.yaml` through `promptfooconfig.yaml`
3. The log is saved and updated `tests/log.md`
