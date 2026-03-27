# STONfi-V2-ConstantSum-Pool-Lock

Security research into a cross-component invariant failure in the STON.fi DEX v2 protocol. This repository contains a full vulnerability analysis, mathematical proof, and a deterministic proof-of-concept demonstrating permanent LP redemption failure.

Disclosed to the STON.fi security team on March 18, 2026.

---

## Summary

The STON.fi DEX v2 shared burn handler in `contracts/pool/msgs/lp_wallet.fc` enforces LP redemption for every pool type in the protocol through a single guard:

```
(int amount0_out, int amount1_out) = pool::get_lp_burn_out(jetton_amount);
throw_unless(error::zero_output, (amount0_out > 0) & (amount1_out > 0));
```

The burn output formula, also shared across all pool types:

```
int left_amount  = muldiv(_lp_amount, storage::reserve0, storage::total_supply_lp);
int right_amount = muldiv(_lp_amount, storage::reserve1, storage::total_supply_lp);
```

When either reserve becomes sufficiently small relative to `total_supply_lp`, this formula returns zero for every possible `lp_amount`. Because the phantom 1001 LP token deficit established at initialization guarantees `lp_amount < total_supply_lp` for every holder at all times, the floor division collapses to zero the moment `reserve = 1`. The burn guard then fires unconditionally for every holder, permanently. The protocol has no automatic recovery mechanism.

This repository documents two manifestations of the same underlying failure.

---

## Findings

### Finding 1  Constant-Sum Pool: Permissionless LP Freeze

**Attack:** Permissionless, single transaction, no special privileges  
**Cost:** ~0.1% of locked value (~1000:1 damage ratio)  

The constant-sum swap output is entirely reserve-independent  the formula contains no reference to current reserve levels. This means draining the last unit of any reserve costs exactly the same as draining any other unit. Combined with the router's reserve floor of 1 and the shared burn guard, a single attacker swap can permanently freeze all LP positions in the pool.

Full analysis: [`Constant-Sum-VE.md`](./Constant-Sum-VE.md)  
Proof of concept: [`ConstantSumLPLock.spec.ts`](./ConstantSumLPLock.spec.ts)

---

### Finding 2  Shared Burn Infrastructure: Design-Level Invariant Failure

**Type:** Design flaw  protocol does not enforce LP redemption invariant structurally  
**Scope:** Weighted constant-product pool (production)  

The protocol assumes that pricing curves make the dangerous reserve state economically unreachable for all pool types. This assumption is implicit, undocumented, and unverified. For the weighted constant-product pool, valid parameter configurations exist under which the burn collapse condition holds from the moment of initialization, with no external manipulation required.

The weight parameter `w0` accepts any value strictly between `0` and `ONE_DEC` with no enforced distance from the extremes. The initialization path enforces only `tot_am0 > 0` and `tot_am1 > 0` — no minimum reserve validation. Under extreme weight configurations, `total_supply_lp` is dominated entirely by `reserve0` while `reserve1` can be initialized to 1, placing every LP holder into the collapse condition immediately.

There is no on-chain signal distinguishing a safely configured pool from an unsafe one. Users who provide liquidity into an unsafe pool receive LP tokens that are permanently unredeemable with no indication.

Full analysis: [`DCB_Pitfall.md`](./DCB_Pitfall.md)

---

## Repository Structure

| File | Description |
|------|-------------|
| `Constant-Sum-VE.md` | Full vulnerability analysis, four-lemma proof, attack mechanics, economic impact |
| `DCB_Pitfall.md` | Design-level invariant failure in weighted pool shared infrastructure |
| `ConstantSumLPLock.spec.ts` | Deterministic proof-of-concept  runs against project's own compiled contracts |

---

## Proof of Concept

The PoC runs against the STON.fi DEX v2 codebase using the project's own test infrastructure, compiled contracts, and sandbox environment. All 36 existing protocol tests pass cleanly in the same environment.

To reproduce:

```bash
git clone https://github.com/ston-fi/dex-core-v2
cd dex-core-v2
npm install
# place ConstantSumLPLock.spec.ts in tests/
npx jest ConstantSumLPLock
```

Expected output:

```
=== INITIAL STATE ===
reserve0                  : 100000.000000000
reserve1                  : 100000.000000000
total_lp_supply           : 100000.000000000
is_locked                 : false

=== ATTACK EXECUTION ===
attack_amount_in          : 100200.400801602
reserve1_after            : 1

=== INVARIANT CHECK ===
max_lp_any_holder         : 99999.999998998
floor(max/total)          : 0

=== BURN VALIDATION ===
burns_failed              : 4/4

=== PROOF CONDITIONS ===
lp_redeemable             : false
automatic_recovery_exists : false
state_is_recoverable      : false

PASS tests/ConstantSumLPLock.spec.ts (6.505 s)
```

---

## Remediation

The fix addresses the shared burn handler, not any specific pool type.

**Option 1:** Modify the burn guard to require at least one positive output rather than both. This preserves dust protection in the normal case while allowing redemption when one reserve has been depleted to its minimum.

**Option 2:** Enforce a minimum reserve floor at initialization and parameter-setting time derived from `total_supply_lp`, such that the collapse condition cannot be entered through any valid protocol operation.

Either fix should be validated across all pool types sharing the burn infrastructure.

---

## Disclosure Timeline

| Date | Event |
|------|-------|
| March 18, 2026 | Initial report submitted to security@ston.fi |
| March 20, 2026 | First follow-up |
| March 22, 2026 | Second follow-up with remediation timeline concern |
| March 25, 2026 | Response received  constant-sum pools excluded from scope |
| March 27, 2026 | Scope dispute submitted  shared infrastructure argument |
| March 27, 2026 | Public disclosure |

---

## License

Released under CC BY-NC 4.0. Others may read, share, and reference this research for non-commercial purposes.
