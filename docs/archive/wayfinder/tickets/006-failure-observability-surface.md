---
title: Failure/observability surface
type: grilling
status: closed
assignee: seaston
blocked-by: []
resolved: 2026-07-22
---

## Question

What does the admin see when sync lags or quota is exhausted? What's the failure/observability surface?

## Resolution

**Decided 2026-07-22:**
- **Start with basic job status only.** Copy the Google Cloud Console pattern: minimal, informative job status notifications.
- **Show:** Job status (running/completed/failed), duration, brief error messages.
- **No advanced observability initially:** No quota exhaustion warnings, no sync lag metrics, no detailed performance dashboards.
- **Can evolve later** based on user feedback and real-world usage patterns.

**Rationale:** Keep the initial implementation lean. The Google Cloud Console job status pattern is proven, familiar to admins, and sufficient for the MVP. Advanced observability can be added incrementally once the core system is stable.

**Implication:** The client's job status section will mirror Google Cloud Console's approach — a simple list or panel showing recent job executions with their status, duration, and any errors.