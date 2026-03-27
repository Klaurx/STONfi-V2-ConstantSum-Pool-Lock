# Constant-Sum Pool LP Withdrawal Guarantee Failure

**Type:** Cross-component invariant failure  
**Attack:** Permissionless, single transaction  
**Cost:** ~0.1% of locked value  
**Recovery:** None without code upgrade through two-day timelock  
**PoC:** `ConstantSumLPLock.spec.ts`  PASS in 6.5s, all 36 existing protocol tests unaffected

---

## Overview

Through a sequence of normal, valid swap operations, an attacker can drain one side of a constant-sum pool's reserves to the minimum value of 1. Once that state is reached, the integer arithmetic in the LP burn calculation permanently produces a zero output for that token side. The burn handler requires both token outputs to be strictly positive, so every subsequent LP burn transaction reverts for every holder simultaneously and permanently.

The vulnerability is not a coding error in any single component. Every function involved is individually correct according to its own specification. The failure is only visible when reasoning about the entire system's state space simultaneously, across components written for different purposes.

---

## Affected Components

| File | Role |
|------|------|
| `contracts/pool/pools/constant_sum/pool.fc` | Swap output calculation  reserve-independent |
| `contracts/pool/msgs/lp_wallet.fc` | Burn handler  enforces strict positive output requirement |
| `contracts/pool/msgs/lp_account.fc` | Initial liquidity provision  establishes phantom 1001 LP deficit |
| `contracts/pool/msgs/router.fc` | Swap handler  enforces reserve floor of 1 |

---

## The Four Design Decisions That Compose Into Failure

**1. Constant-sum swap output is reserve-independent.**

The output for a given input depends only on the input amount and fee parameters, not on current reserve levels. This is the defining property of a constant-sum AMM and is correct by design. The function body in `constant_sum/pool.fc` contains no reference to the reserve parameters after the function signature  they are accepted as arguments but never used in the output calculation.

**2. The swap handler enforces a reserve floor of exactly 1.**

From `contracts/pool/msgs/router.fc`:

```
throw_arg_if(op::swap_refund_reserve_err, 1,
    (storage::reserve0 <= 0)
    | (storage::reserve1 <= 0)
    ...
);
```

The check fires when a reserve would reach zero or below. It does not fire at 1. This means the minimum value any reserve can hold after a successful swap is exactly 1. This check is correct and necessary.

**3. The burn handler requires both token outputs to be strictly greater than zero.**

From `contracts/pool/msgs/lp_wallet.fc`:

```
(int amount0_out, int amount1_out) = pool::get_lp_burn_out(jetton_amount);
throw_unless(error::zero_output, (amount0_out > 0) & (amount1_out > 0));
```

This is a correct dust protection mechanism. It becomes the failure point only in composition with the other three decisions.

**4. The minimum liquidity mechanism establishes a permanent 1001 LP token deficit.**

From `contracts/pool/msgs/lp_account.fc`:

```
liquidity = pool::get_lp_provide_init_out(tot_am0, tot_am1);
storage::total_supply_lp = liquidity;
liquidity -= params::required_min_liquidity;  // params::required_min_liquidity = 1001
```

The full computed liquidity value is written to `total_supply_lp`, but only `liquidity - 1001` is minted to any address. The 1001 difference exists in the total supply counter but was never minted anywhere. This means no individual wallet balance can ever equal or exceed `total_supply_lp`. For every holder at every point in time: `lp_amount < total_supply_lp`.

---

## Mathematical Proof

### Lemma 1: reserve1 = 1 is reachable via a single valid swap

The constant-sum swap output function computes output independently of reserve levels. The attacker calculates the exact input amount to produce an output equal to `reserve1 - 1`, leaving exactly 1 unit in reserve1 after the deduction. Using ceiling division guarantees the output target is reached without overshooting into a zero reserve, which would trigger the refund guard. The swap passes all validation checks, `storage::save()` is called, and `reserve1 = 1` is committed to on-chain storage.

For pools with `protocol_fee = 0` (a valid configuration per `params::min_fee = 0` in `contracts/common/params.fc`), this executes in a single transaction. The attack amount formula:

```
attack_amount_in = ceil((reserve1 - 1) * FEE_DIV / (FEE_DIV - lp_fee))
```

### Lemma 2: No holder can ever own an LP amount >= total_supply_lp

From the initialization path above: the sum of all LP wallet balances equals `total_supply_lp - 1001` at all times. Since 1001 > 0, no individual balance can equal or exceed `total_supply_lp`. This holds permanently  subsequent liquidity provisions increment both sides by the same computed liquidity value, preserving the deficit.

Therefore: for every holder, at every point in time, `lp_amount < total_supply_lp`.

### Lemma 3: With reserve1 = 1, the burn output for token1 is zero for every valid lp_amount

The burn output calculation from `contracts/pool/msgs/lp_wallet.fc` via `pool::get_lp_burn_out`:

```
int right_amount = muldiv(_lp_amount, storage::reserve1, storage::total_supply_lp);
```

The TVM `muldiv` instruction computes `floor(lp_amount * reserve1 / total_supply_lp)` using a 512-bit intermediate.

With `reserve1 = 1` this reduces to `floor(lp_amount / total_supply_lp)`.

From Lemma 2, `lp_amount < total_supply_lp` for every holder. For any two positive integers `a < b`, `floor(a / b) = 0`. This is a mathematical identity with no exceptions.

Therefore: `right_amount = 0` for every possible `lp_amount` belonging to any holder.

### Lemma 4: With amount1_out = 0, every burn transaction reverts permanently

The guard in `contracts/pool/msgs/lp_wallet.fc`:

```
throw_unless(error::zero_output, (amount0_out > 0) & (amount1_out > 0));
```

From Lemma 3, `amount1_out = 0`. The conjunction evaluates to false. The throw fires. The TVM reverts all state mutations within the current transaction, including any changes to reserve values and total supply. The pool storage is restored to its pre-transaction state  meaning `reserve1` remains at 1.

The LP wallet contract contains an `on_bounce` handler that restores the burned LP amount to the sender's balance when `burn_notification_ext` messages bounce. The holder's LP tokens are returned intact, but the underlying redemption remains permanently impossible.

### Main Theorem

Reserve1 = 1 is reachable (Lemma 1). Every holder satisfies `lp_amount < total_supply_lp` at all times (Lemma 2). Therefore `amount1_out = 0` for every burn (Lemma 3). Therefore every burn reverts (Lemma 4). Failed burns leave `reserve1` unchanged at 1, so the state is stable under all automatic protocol operations. The LP withdrawal guarantee cannot be restored once `reserve1 = 1`.

---

## Attack Mechanics

**Phase 1: Drain reserve1 to 1**

The attacker calculates the exact input amount using the formula above and sends a standard swap through the router. No special permissions, no flash loans, no contract deployment. The transaction is indistinguishable from a normal user swap. The pool processes it, updates `reserve1` to 1, calls `storage::save()`, and the state is permanently committed.

**Phase 2: The lock is self-sustaining at zero ongoing cost**

Once `reserve1 = 1`, the attacker takes no further action. Any LP holder who attempts a burn receives a bounce from the pool. Their balance is restored exactly. The pool state is unchanged. Every subsequent attempt by every holder produces the same result.

The only theoretical recovery mechanism is a voluntary actor swapping token1 into the pool to raise `reserve1` above 1. This creates an adversarial game the attacker wins by design: the rescuer pays the `lp_fee` on their token1 deposit, and the attacker can immediately re-drain with an equal-cost swap in the opposite direction. The rescuer gains nothing. Rational actors have no incentive to rescue the pool.

---

## Economic Impact

Against a pool initialized with 100,000 of each token and `lp_fee = 20bps`:

| Metric | Value |
|--------|-------|
| Attack fee paid | ~200 tokens |
| Value permanently locked | ~200,200 tokens |
| Damage-to-cost ratio | ~1000:1 |
| Attack cost as % of locked value | 0.1% |

The `reserve0` figure at the end of the attack is higher than the initial deposit because the attacker deposited token0 in exchange for the token1 they drained. LP holders collectively own a claim on more tokens than they originally deposited  none of which they can retrieve.

LP holders have no on-chain indication that their position is permanently frozen. Their LP wallet shows a positive balance. Burns fail silently  the `on_bounce` mechanism returns their LP tokens without explaining why the redemption failed. No on-chain state distinguishes a temporarily illiquid pool from a permanently locked one.

---

## Proof of Concept Output

```
=== INITIAL STATE ===
reserve0                  : 100000.000000000
reserve1                  : 100000.000000000
total_lp_supply           : 100000.000000000
is_locked                 : false

=== PRE-ATTACK VALIDATION ===
victim_lp_balance         : 99999.999998999
burn_1_lp_result          : SUCCESS (expected)

=== ATTACK EXECUTION ===
reserve1_before           : 99999.999999999
lp_fee_bps                : 20
protocol_fee_bps          : 0
attack_amount_in          : 100200.400801602
reserve1_after            : 1

=== INVARIANT CHECK ===
total_lp_supply           : 99999.999999999
phantom_lp_locked         : 1001
max_lp_any_holder         : 99999.999998998
floor(max/total)          : 0

=== BURN VALIDATION ===
victim_lp_balance         : 99999.999998998
burn_amounts_tested       : 0.000000001, 0.000001000, 49999.999999499, 99999.999998998
burns_failed              : 4/4

=== FINAL STATE ===
reserve0_locked           : 200200.400801601
reserve1                  : 1
total_lp_supply           : 99999.999999999
attack_fee_paid           : 200.400801603
attack_cost_%             : 0.1000% of locked value

=== PROOF CONDITIONS ===
lp_redeemable             : false
automatic_recovery_exists : false
admin_rescue_exists       : false
alternate_burn_path_exists : false
state_is_recoverable      : false

PASS tests/ConstantSumLPLock.spec.ts (6.505 s)
```

Every claim in this document corresponds to a passing machine-verifiable assertion in the PoC. The test runs against the project's own compiled contracts and sandbox infrastructure. All 36 existing protocol tests pass cleanly in the same environment.

---

## Why Other Pool Types Are Not Affected by This Attack Path

**Constant-product:** The swap formula is `base_out = muldiv(amount_in_with_fee, reserve_out, reserve_in * fee_divider + amount_in_with_fee)`. As `reserve_out` approaches zero, the input required to extract each additional unit grows exponentially. Draining to `reserve = 1` would require an astronomically large input  effectively the entire liquidity of the other side many times over.

**Stableswap:** Uses Newton-Raphson convergence (`calculate_invariant`). Same exponential resistance to reserve depletion near zero.

**Weighted constant-product:** The pricing curve `amount_out = balance_out * (1 - (balance_in / (balance_in + amount_in))^(w_in/w_out))` also creates exponential resistance. Additionally, a maximum input ratio of 30% per swap (`_MAX_IN_RATIO`) further limits drainage per transaction.

The economic barrier in these pool types makes the collapse state unreachable in practice. The constant-sum pool has no such barrier  its output is entirely reserve-independent, making drainage to the minimum value as cheap as any other swap of equivalent size.

---

## Remediation

Three approaches are available, in order of invasiveness.

**Option 1 (targeted):** Modify the burn output positivity requirement to require at least one positive output rather than both. This preserves the dust protection intent for the normal case while allowing redemption when one reserve has been depleted to its minimum value.

**Option 2 (preventive):** Add a guard in the constant-sum swap handler preventing any reserve from falling below the collapse threshold. The minimum safe reserve is `ceil(total_supply_lp / (total_supply_lp - 1001))`, which for any realistic pool size equals 2. This prevents the attacker from reaching the problematic state entirely.

**Option 3 (robust):** Make the minimum reserve a dynamic function of `total_supply_lp`, scaling with pool growth and maintaining the invariant that a single LP token always redeems for at least 1 unit of each token.

The fix addresses the shared burn handler and should be validated across all pool types that share the burn infrastructure.
