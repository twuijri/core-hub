# ADR 0018 — Core Hub is licensed under the Apache License 2.0

Status: accepted (2026-09-24, owner: «والرخصة خلها ابراتشي»).
Replaces: the placeholder in `LICENSE` ("proprietary until the owner chooses a licence").

## Context
The repository has been public since it was renamed `twuijri/core-hub`, but `LICENSE` said
"all rights reserved" and every package said `UNLICENSED`. A public repository with no licence
grants nobody the right to use, change or share the code, which contradicts publishing it and
leaves contributors unsure what their contributions fall under. The README rewrite (#96)
quoted that placeholder and asked the owner to choose.

## Decision
- `LICENSE` is the unmodified text of the Apache License, Version 2.0.
- `NOTICE` names the product and the copyright holder (`Copyright 2026 twuijri`); Apache 2.0
  §4(d) requires redistributions to carry it.
- The root `package.json` declares `"license": "Apache-2.0"`, and the contract's `info.license`
  says the same.
- Third-party code keeps its own licence (`THIRD-PARTY-NOTICES.md`, e.g. the MIT agent marks);
  Hermes Agent stays MIT and is not relicensed by shipping inside the image.
- Clean room (ADR 0004) is unchanged: nothing from Hermes Studio / Ekko Studio (BSL 1.1) may
  enter this repository, whatever licence this repository carries.

## Alternatives rejected
- **MIT:** shorter, but no explicit patent grant and no NOTICE mechanism.
- **Keeping it proprietary:** contradicts a public repository and blocks outside contributions.
- **A copyleft licence (GPL/AGPL):** not what the owner chose.

## Consequences
- Anyone may use, modify and redistribute Core Hub, including commercially, provided they keep
  the licence and NOTICE, state their changes and do not use the owner's trademarks as their own.
- Contributions are accepted under Apache 2.0 (§5), with no separate CLA.
