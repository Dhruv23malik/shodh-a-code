# Seed identities — Shodh a Code (Stage 1)

Dev auth: `Authorization: Bearer dev:<user-uuid>`

## Organizations

| Org | Slug | UUID |
| --- | --- | --- |
| Acme University | acme | `11111111-1111-4111-8111-111111111111` |
| Vertex College | vertex | `22222222-2222-4222-8222-222222222222` |

## Users

| Name | Email | Role | UUID | Dev bearer token |
| --- | --- | --- | --- | --- |
| Ana Sharma | ana@acme.example | organizer (acme) | `aaaaaaaa-0001-4000-8000-000000000001` | `Bearer dev:aaaaaaaa-0001-4000-8000-000000000001` |
| Vikram Rao | vikram@vertex.example | organizer (vertex) | `aaaaaaaa-0002-4000-8000-000000000002` | `Bearer dev:aaaaaaaa-0002-4000-8000-000000000002` |
| Priya Nair | priya@example.com | participant (acme) | `aaaaaaaa-0003-4000-8000-000000000003` | `Bearer dev:aaaaaaaa-0003-4000-8000-000000000003` |
| Arjun Mehta | arjun@example.com | participant (acme) | `aaaaaaaa-0004-4000-8000-000000000004` | `Bearer dev:aaaaaaaa-0004-4000-8000-000000000004` |
| Meera Iyer | meera@example.com | participant (acme + vertex) | `aaaaaaaa-0005-4000-8000-000000000005` | `Bearer dev:aaaaaaaa-0005-4000-8000-000000000005` |
| Kabir Singh | kabir@example.com | participant (acme + vertex) | `aaaaaaaa-0006-4000-8000-000000000006` | `Bearer dev:aaaaaaaa-0006-4000-8000-000000000006` |

## Contests (both `open`, 2026-11-01 → 2026-12-31, penalty 20)

| Contest | Org | Slug | UUID |
| --- | --- | --- | --- |
| Acme Weekly #1 | acme | acme-weekly-1 | `c0000000-0001-4000-8000-000000000001` |
| Vertex Sprint | vertex | vertex-sprint | `c0000000-0002-4000-8000-000000000002` |

Seeded joins: Priya + Arjun joined Acme Weekly #1; Meera + Kabir joined Vertex Sprint.

## Problems (org acme, version 1, suite v1, 3 cases each: 1 visible + 2 hidden)

| Problem | Slug | UUID | Version UUID | Suite UUID |
| --- | --- | --- | --- | --- |
| Add Two Numbers | add-two-numbers | `10000000-0001-4000-8000-000000000001` | `20000000-0001-4000-8000-000000000001` | `30000000-0001-4000-8000-000000000001` |
| FizzBuzz Lite | fizzbuzz-lite | `10000000-0002-4000-8000-000000000002` | `20000000-0002-4000-8000-000000000002` | `30000000-0002-4000-8000-000000000002` |
| Sort Numbers | sort-numbers | `10000000-0003-4000-8000-000000000003` | `20000000-0003-4000-8000-000000000003` | `30000000-0003-4000-8000-000000000003` |

Test case UUIDs are `40000000-000N-4000-8000-00000000000N` (N = 1..9, in problem/case order above).
