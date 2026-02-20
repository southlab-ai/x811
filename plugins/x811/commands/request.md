---
description: Start autonomous initiator mode — discover a provider, negotiate, verify result, and pay
argument-hint: "<capability> <budget>"
---

# /x811:request

Find a provider agent, send a task request, auto-accept the offer, wait for the result, verify it, and pay — all autonomously.

## Usage

```
/x811:request financial-analysis 0.05
/x811:request code-review 0.10
```

## Workflow

1. Parse the capability (first word) and max budget in USDC (second word) from arguments
2. Ask the user for task details/parameters if not obvious from context
3. Call `x811_request_and_pay` with:
   - `name`: a sensible agent name based on context
   - `capability`: the parsed capability
   - `max_budget`: the parsed budget
   - `parameters`: any task-specific parameters
   - `timeout_seconds`: 120
4. Display the result to the user when the negotiation completes
