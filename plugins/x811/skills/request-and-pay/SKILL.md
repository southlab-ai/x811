---
name: request-and-pay
description: Activate when the user wants to find an AI agent provider, request a task, and pay for the result via x811 protocol
---

## When to Use This Skill

Activate when the user:
- Wants to "hire an agent" or "find a provider" on x811
- Says "request a task" or "get work done by another agent"
- Asks to "discover and pay" for a specific capability
- Mentions wanting to use USDC to pay an AI agent for work

## Process

1. Determine what capability the user needs (e.g., "code-review", "financial-analysis")
2. Ask for the maximum budget in USDC
3. Gather any task-specific parameters or description
4. Call `x811_request_and_pay` with capability, budget, and parameters
5. Present the result to the user when the full negotiation cycle completes

## Guidelines

- The autonomous tool handles discovery, requesting, accepting, verification, and payment automatically
- If no provider is found, suggest the user check that a provider is online with that capability
- The tool auto-accepts offers within budget — no manual intervention needed
