# Shared Burn Infrastructure  Design-Level Invariant Failure (Weighted Pool)

**Type:** Design flaw  protocol does not enforce LP redemption invariant structurally  
**Scope:** Weighted constant-product pool (`contracts/pool/pools/weighted_const_product/`)  
**Trigger:** Valid administrative parameter configuration  
**Recovery:** None without code upgrade through two-day timelock  

---

## Overview

The STON.fi DEX v2 protocol does not enforce the invariant that LP tokens must always be redeemable for non-zero amounts of both assets. That invariant is assumed by the shared burn handler but guaranteed by nothing in the protocol itself. Instead, the protocol relies entirely on each pool type's pricing curve to make the dangerous state economically unreachable. That reliance is implicit, undocumented, and unverified across pool types.

For the weighted constant-product pool, which is in production, there exist valid parameter configurations under which the burn collapse condition holds from the moment of initialization  before any swap or external interaction occurs. Users who provide liquidity into such a pool receive LP tokens that are permanently unredeemable. There is no on-chain signal indicating the pool is unsafe, and there is no recovery path that does not require a code upgrade staged through the two-day timelock.

---

## The Shared Failure Point

This finding is an extension of the constant-sum pool analysis. The collapse condition is identical across all pool types because the burn handler and burn output formula are shared infrastructure.

From `contracts/pool/msgs/lp_wallet.fc`:

```
(int amount0_out, int amount1_out) = pool::get_lp_burn_out(jetton_amount);
throw_unless(error::zero_output, (amount0_out > 0) & (amount1_out > 0));
```

From `pool::get_lp_burn_out`  identical in every pool implementation:

```
// contracts/pool/pools/constant_product/pool.fc
// contracts/pool/pools/stableswap/pool.fc
// contracts/pool/pools/weighted_const_product/pool.fc
// contracts/pool/pools/weighted_stableswap/pool.fc
int left_amount  = muldiv(_lp_amount, storage::reserve0, storage::total_supply_lp);
int right_amount = muldiv(_lp_amount, storage::reserve1, storage::total_supply_lp);
```

The collapse condition is:

```
floor(lp_amount * reserve / total_supply_lp) = 0
```

This holds when `lp_amount * reserve < total_supply_lp`. Because the phantom 1001 LP deficit established at initialization guarantees `lp_amount < total_supply_lp` for every holder at all times, the strongest case simplifies to: **when `reserve = 1`, the collapse is universal and affects every holder**.

The constant-sum pool provided a permissionless swap-based path to `reserve = 1`. The weighted pool provides a configuration-based path to the same state  reachable at initialization under valid protocol parameters.

---

## How the Weighted Pool Reaches the Collapse State

### The Weight Parameter Has No Safety Floor

From `contracts/router/pools/weighted_const_product/ext_admin.fc`:

```
throw_unless(error::invalid_amount, (0 < new_w) & (new_w < math::ONE_DEC));
```

`w0` must be strictly between `0` and `ONE_DEC` (`1e18`). There is no minimum distance from the extremes. A value of `w0 = 1` (representing a weight of `1e-18`, effectively zero) is valid under current protocol rules.

### The Weighted Pool Invariant

```
invariant = reserve0^w0 * reserve1^w1
```

where `w1 = ONE_DEC - w0 = complement(w0)`.

When `w0` approaches `ONE_DEC`, the exponent on `reserve1` approaches zero. Any positive number raised to the power of zero equals one. The invariant therefore becomes almost entirely independent of `reserve1` and is dominated entirely by `reserve0`.

The initial LP supply is derived from this invariant:

```
// contracts/pool/pools/weighted_const_product/pool.fc
int inv0 = _invariant(_left_amount, _right_amount, storage::w0, storage::w0.math::fp::complement());
return math::fp::to(inv0);  // inv0 / 1e18
```

With extreme weights, `total_supply_lp ≈ reserve0^~1 / 1e18 ≈ large number` regardless of how small `reserve1` is.

### The Initialization Path Has No Minimum Reserve Validation

From `contracts/pool/msgs/lp_account.fc`:

```
throw_unless(error::low_liquidity, (tot_am0 > 0) & (tot_am1 > 0));
liquidity = pool::get_lp_provide_init_out(tot_am0, tot_am1);
storage::total_supply_lp = liquidity;
liquidity -= params::required_min_liquidity;  // 1001
storage::reserve0 += tot_am0;
storage::reserve1 += tot_am1;
```

The only check is `tot_am0 > 0` and `tot_am1 > 0`. `reserve1 = 1` passes this check. There is no validation that the resulting `reserve / total_supply_lp` ratio preserves the LP redemption guarantee.

### The Collapse Condition at Initialization

With:
- `w0 = ONE_DEC - 1` (minimum valid value for `w1`)
- `reserve0 = large` (e.g., 1,000,000 tokens)
- `reserve1 = 1`

The invariant at initialization is approximately `reserve0^~1 * 1^~0 ≈ reserve0`. So:

```
total_supply_lp ≈ reserve0 / 1e18 * 1e18 = reserve0 = large
```

The burn output for token1 for any holder:

```
right_amount = floor(lp_amount * 1 / large_total_supply) = 0
```

The burn guard fires. Every burn reverts. Every LP holder is frozen from the moment the pool is initialized, before any interaction occurs.

---

## Why This Is Dangerous Despite Being Admin-Gated

The trust boundary is the admin or deployment layer. An external attacker cannot directly trigger this condition without admin access. However:

**1. Users cannot detect the unsafe state.**

No on-chain field reflects whether a pool's parameter configuration preserves the LP redemption guarantee. A user examining pool storage sees positive reserves, positive LP supply, and an unlocked pool  identical to a safely configured pool. The LP wallet shows a positive balance after deposit. Burns fail silently via the `on_bounce` mechanism, returning LP tokens without any indication of why redemption is impossible.

**2. The protocol provides no guard at the configuration layer.**

The weight parameter setter in `contracts/router/pools/weighted_const_product/ext_admin.fc` validates only bounds. There is no cross-validation against current or expected reserves. An admin misconfiguring `w0`  even accidentally  can permanently lock all future LP holders in the pool with no warning and no automatic detection.

**3. Recovery requires a code upgrade staged through the two-day timelock.**

The admin has no opcode that writes directly to pool reserves. The pool code upgrade path calls `set_code` only and does not migrate storage. Any rescue requires designing and deploying a new opcode under time pressure, while all LP holders remain frozen, with the two-day timelock running. Upon completion, if the root cause is not fixed at the protocol level, the unsafe configuration can be set again.

**4. The assumption of economic safety is unverified across pool types.**

The constant-sum pool demonstrated this failure permissionlessly. The weighted pool demonstrates that the same shared infrastructure fails under valid configurations. The protocol's implicit assumption  that pricing curves always protect the burn invariant  is structurally unverified. It is not documented as a protocol requirement, not enforced at the configuration layer, and not caught by any existing validation.

---

## Comparison to Finding 1

| Property | Constant-Sum (Finding 1) | Weighted Pool (Finding 2) |
|----------|--------------------------|---------------------------|
| Attack vector | Permissionless swap | Admin parameter configuration |
| Path to reserve = 1 | Single transaction | Pool initialization with extreme w0 |
| LP freeze scope | Universal  all holders | Universal  all holders from init |
| On-chain signal | None | None |
| Recovery path | Code upgrade + timelock | Code upgrade + timelock |
| Shared failure point | `lp_wallet.fc` burn guard | `lp_wallet.fc` burn guard |

The pool type determines how the dangerous state is reached. The infrastructure that fails when it is reached is identical.

---

## Remediation

The fix addresses the shared handler, not any specific pool type.

**Option 1 (targeted):** Modify the burn guard to require at least one positive output rather than both. This preserves the dust protection intent while allowing redemption when one reserve has been depleted to its minimum value. This resolves both findings simultaneously.

**Option 2 (preventive for weighted pool):** Add validation in `set_params` that checks whether the proposed `w0` combined with any reasonable reserve configuration could produce a collapse condition. Specifically, reject weight configurations where `1 / total_supply_lp_estimate < 1`, where the estimate is derived from the current or expected reserve scale.

**Option 3 (robust):** Enforce a dynamic minimum reserve floor at initialization time derived from `total_supply_lp`, ensuring that `floor(1 * reserve / total_supply_lp) >= 1` always holds for at least the smallest meaningful LP position. This prevents the collapse condition from being entered through any valid protocol operation.

All options should be validated across every pool type sharing the burn infrastructure.
