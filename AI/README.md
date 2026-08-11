# AETERNA AI Documentation

Version: 1.0

Status: Canonical

---

# Purpose

This directory contains the AI operating documentation required by Artificial Intelligence systems participating in the AETERNA project.

These documents define how AI systems must operate while working on AETERNA.

The AI documentation governs the engineering workflow.

It supplements the project's canonical documentation.

Whenever a task is governed by additional canonical documentation outside the AI directory, the applicable canonical documentation shall also be consulted before inspecting implementation.

Documentation defines the protocol.

Source code implements the protocol.

---

# Reading Order

Every AI shall read the documentation in the following order:

1. AI_CONSTITUTION.md
2. 02_PROJECT_INTAKE.md
3. 03_MASTER_PROMPT.md
4. 04_AGENT_RULES.md
5. 05_REVIEW_PROCESS.md
6. 06_HANDOFF_PROTOCOL.md
7. 07_PROJECT_GLOSSARY.md
8. 08_DESIGN_PRINCIPLES.md

Applicable canonical documentation shall then be reviewed before inspecting implementation.

---

# Templates

templates/

Contains role templates for specialized AI systems.

Examples include:

- Chief Architect
- Documentation Engineer
- Implementation Engineer
- Protocol Reviewer
- QA Reviewer
- Security Reviewer
- Release Manager

Each role template defines responsibilities for a specific engineering function.

Templates supplement the AI Constitution.

They never override it.

---

# Examples

examples/

Contains reference examples of:

- protocol analysis;
- implementation plans;
- reviews;
- handoffs.

Examples illustrate the required format.

Examples never override canonical documentation.

---

# Checklists

checklists/

Contains standardized engineering checklists used during:

- implementation;
- review;
- auditing;
- release.

Checklists supplement canonical documentation.

They never replace it.

---

# Relationship to Canonical Documentation

The AI documentation defines:

- engineering workflow;
- AI responsibilities;
- review methodology;
- documentation process.

The canonical documentation defines:

- protocol behavior;
- engineering model;
- project logic;
- system logic;
- canonical specifications.

AI systems shall follow both.

Whenever canonical documentation governs the requested task, it has higher authority than implementation.

---

# Final Rule

No AI may inspect implementation before:

1. Reading the required AI documentation.
2. Reading all applicable canonical documentation governing the requested task.

Whenever uncertainty exists:

1. Read the applicable documentation.
2. Follow the defined engineering workflow.
3. Inspect implementation only after the governing documentation has been reviewed.

Never infer protocol behavior from implementation.

Never modify canonical documentation to justify implementation.