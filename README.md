# STONfi-V2-ConstantSum-Pool-Lock


# Overview

This repository contains a detailed analysis and proof-of-concept demonstrating a permanent LP redemption failure in constant-sum 
pools on the STON.fi DEX v2 protocol. 
The issue arises from the interaction of correctly implemented components that together allow a reachable state in which LP tokens become non-redeemable, despite appearing active in holders balances.

The vulnerability is not a coding bug in individual components, but a cross-component invariant failure: the system assumes that positive pool reserves guarantee positive LP burn outputs, which does not hold in certain configurations.

Note: The full exploit is applicable to constant-sum pools. The security team has indicated that these pool types will not be deployed, so this PoC will remain as a demonstration for research purposes only. But the same math issue exists in other components.

The 2 scenarios:
Constant-Sum Pool Demo
In constant-sum pools, the sum of reserves is always constant:

reserve0 + reserve1 = constant.
Large swaps or withdrawals can fully deplete one token, making LP tokens permanently non-redeemable.
This repo includes a fully working PoC exploit for constant-sum pools.
Important: The security team has decided not to deploy constant-sum pools, so this demo remains a research/proof-of-concept only.

Weighted Pool / Full Configuration Bug
In weighted pools, LP token redemption assumes the invariant always holds.
Certain parameter selections at the admin or deployment layer can violate this assumption, leading to locked LP tokens.
Unlike the constant-sum pool, this bug is conditional on pool configuration. Users cannot detect unsafe setups from on-chain data, and the protocol emits no guard or signal.
This demonstrates a design-level security risk, even if traditional bug bounty triage may classify it as a configuration or UX issue.

License

This repository is released under the Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)
 license.

This license allows others to read, share, and reference the research for non-commercial purposes, while preventing direct commercial exploitation.
