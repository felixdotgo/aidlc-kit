# Design — <Title>

## 🧩 Solution per affected area
- `<area>` — <approach, target, and reuse candidate>

## 📌 Spec traceability
| design element | source | exact quote / approved decision |
|----------------|--------|---------------------------------|
| <quantified rule or contract> | <path:line, rule ID, or user decision> | <exact source> |

## 🔗 Cross-service contracts
- <contract or `none`>

## 🔀 Parallel work partition
| item | owned paths | depends on | verification |
|------|-------------|------------|--------------|
| <item-id> | <paths it alone writes> | <item-ids or `none`> | <narrow command> |

- One owner per path among items that can run at the same time; overlapping items must be ordered with `dependsOn`.
- Shared surfaces (barrel/index files, shared config, cross-cutting docs, a single entry script) get exactly one owning item; others depend on it.
- Prefer file/module-level ownership over broad parent directories.

## ⚠️ Risks / edge cases
- <risk and mitigation>
