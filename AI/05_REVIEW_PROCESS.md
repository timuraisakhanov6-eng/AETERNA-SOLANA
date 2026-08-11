# AETERNA Review Process

Version: 1.0

Status: Canonical

---

# Purpose

This document defines the mandatory review process for every completed task within the AETERNA project.

No implementation is considered complete until this review process has been performed.

---

# General Principle

Implementation is only one stage of development.

Every implementation must be reviewed before it is considered complete.

---

# Review Objectives

Every review must verify:

- protocol correctness;
- architectural consistency;
- implementation correctness;
- security;
- documentation consistency;
- maintainability.

---

# Mandatory Review Order

Every completed task must be reviewed in the following order.

1. Protocol Review
2. Architecture Review
3. Implementation Review
4. QA Review
5. Security Review
6. Documentation Review
7. Final Report

The order is mandatory.

---

# Review Ownership

The standard ownership of the review stages is:

| Review Stage | Responsible Role |
|---|---|
| Protocol Review | Protocol Reviewer |
| Architecture Review | Chief Architect |
| Implementation Review | Implementation Engineer |
| QA Review | QA Reviewer |
| Security Review | Security Reviewer |
| Documentation Review | Documentation Engineer |
| Final Report | Release Manager |

Each review stage is performed independently by its assigned role.

---

# Review Independence

Whenever possible:

The implementation should not be the only source of validation.

Documentation must always be used during review.

Canonical documentation has higher authority than implementation.

---

# Protocol Review

Verify that the implementation preserves all applicable protocol rules.

Confirm that:

- no protocol invariant has been violated;
- no protocol behavior has changed unintentionally;
- no undocumented protocol behavior has been introduced.

Every detected protocol issue must be reported.

---

# Architecture Review

Verify that architectural boundaries remain unchanged.

Confirm that:

- authority boundaries are preserved;
- component responsibilities remain unchanged;
- no architectural shortcuts have been introduced;
- implementation still matches the canonical architecture.

---

# Implementation Review

Review the implementation itself.

Verify:

- correctness;
- readability;
- maintainability;
- consistency with existing implementation patterns.

Avoid unrelated modifications.

---

# QA Review

Validate that the completed work satisfies the requested objective.

Verify:

- implementation completeness;
- implementation quality;
- protocol compliance;
- documentation consistency;
- readiness for completion.

The QA Reviewer validates quality.

The QA Reviewer does not redesign implementation.

---

# Security Review

Review all security-sensitive changes.

Verify:

- cryptographic correctness;
- authority separation;
- secret handling;
- client/server boundaries;
- error handling.

Security must never be weakened for convenience.

---

# Documentation Review

Verify that documentation remains consistent with the canonical documentation.

Verify that implementation references remain accurate and consistent with approved implementation changes.

If documentation updates are required:

- identify them;
- justify them;
- request approval before modifying canonical documentation.

---

# Final Report

Every completed task must end with a structured report.

The report must include:

- objective;
- completed work;
- affected files;
- protocol rules involved;
- review results;
- remaining limitations;
- recommended next steps.

Facts must be clearly separated from recommendations.

---

# Completion Criteria

A task is considered complete only if:

- implementation is finished;
- mandatory reviews have been completed;
- protocol integrity has been verified;
- architectural consistency has been verified;
- QA review has been completed;
- security review has passed;
- documentation consistency has been verified;
- the final report has been produced.

If any of these conditions is not satisfied, the task is not complete.