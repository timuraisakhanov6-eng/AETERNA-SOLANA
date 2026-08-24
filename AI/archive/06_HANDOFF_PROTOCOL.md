# AETERNA Handoff Protocol

Version: 1.0
Status: Canonical

---

# Purpose

This document defines how work is transferred between AI systems.

The objective of a handoff is to preserve context, continuity, and protocol integrity.

Every handoff must allow another AI to continue work without reconstructing project history.

---

# General Principle

A handoff is not a conversation summary.

A handoff is an engineering status report.

It must describe the current state of the project, not the history of the discussion.

---

# Mandatory Handoff Contents

Every handoff must contain:

- current project objective;
- current implementation status;
- completed work;
- remaining work;
- known issues;
- open questions;
- applicable canonical documents;
- protocol constraints.

Nothing essential may be omitted.

---

# Canonical Rule

A handoff must never redefine protocol behavior.

A handoff summarizes implementation state.

It does not modify architecture.

It does not modify canonical documentation.