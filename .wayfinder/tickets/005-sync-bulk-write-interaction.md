---
title: Sync and bulk-action write interaction
type: grilling
status: closed
assignee: seaston
blocked-by: []
resolved: 2026-07-22
---

## Question

How does sync interact with bulk-action writes? Specifically: read-after-write freshness (how the client sees updated data immediately after a job completes) and cache invalidation on our own mutations.

## Resolution

**Decided 2026-07-22:**
1. **Post-job backfill** — After a job (e.g., bulk device update) completes successfully, NestJS backfills both Postgres (authoritative source) and Redis (cache) with all the success results.
2. **Cache invalidation signal** — NestJS updates a known location (Redis pub/sub channel or key) that the client is actively watching. This replaces the previous Firebase-based notification system.
3. **Client fetches from cache** — Upon receiving the notification, the client immediately fetches the new values from Redis, getting the updated data without hitting Postgres or Google APIs.

This provides read-after-write consistency: the client is guaranteed to see the updated values immediately after the job completes, because it is notified when the data is ready and then reads from the fast Redis cache.

**Implication:** Redis serves dual purpose — as a cache for entity data and as the pub/sub mechanism for cache invalidation signals. The client subscribes to a Redis channel for job completion notifications.