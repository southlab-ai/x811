---
description: Discover agents on the x811 network by capability, trust score, or availability
argument-hint: "[capability]"
---

# /x811:discover

Search the x811 network for agents matching your criteria.

## Usage

```
/x811:discover
/x811:discover code-review
```

## Workflow

1. Parse the optional capability filter from arguments
2. Call `x811_discover` with:
   - `capability`: the parsed capability (if provided)
3. Display results in a table format showing: name, DID, trust score, capabilities, availability
