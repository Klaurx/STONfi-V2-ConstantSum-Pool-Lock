# Deployment Configuration Bug (Weighted Pool Misconfiguration)

# Overview


This bug arises not from a flaw in the core swap logic itself, but from the lack of enforcement of safety invariants at the pool configuration layer. Specifically, the protocol allows an administrator or deployer to configure weighted pools with parameters that can permanently lock LP tokens, yet provides no on-chain guard, validation, or signal indicating whether the pool is safe or unsafe.

In other words:

Trust boundary: Users must implicitly trust that the pool deployer chose safe parameters.
Exploitability: While no external attacker can forcibly trigger this, a user acting normally (depositing/redeeming LP tokens) can inadvertently cause losses if the pool is unsafe.
Protocol perspective: Technically, the swap math is working “as intended,” but the absence of invariant enforcement or signaling is a design-level security flaw.


What the Bug Looks Like

Weighted pools allow admins to set:

Weights of each token (e.g., 90%/10%, 50%/50%, etc.)
Swap fees
Initial liquidity

A safe pool should enforce that redemption always preserves invariant: users can redeem proportional value of LP tokens at any time.

Here, the protocol does not check the invariant:

```
// Pseudo-code example
function redeem(uint256 lpAmount) external {
    // Compute token amounts according to pool weights
    (uint256 amount0, uint256 amount1) = calcRedeem(lpAmount);

    // No invariant guard:
    // There is no require(amount0 > 0 && amount1 > 0)
    // There is no on-chain flag indicating pool safety

    token0.transfer(msg.sender, amount0);
    token1.transfer(msg.sender, amount1);
}
```

Logical Flow
Pool Deployment: Admin sets arbitrary weights and initial liquidity.
LP Minting: Users deposit tokens, minting LP tokens proportional to total pool value.
Redemption: User calls redeem(lpAmount).

The problem:

Certain weight combinations + initial balances can produce a situation where calcRedeem() returns zero or extremely small token amounts for one or more assets.
Users are unable to distinguish safe pools from unsafe ones, because no on-chain state reflects pool safety.
A user performing standard operations (deposit → redeem) can permanently lock their funds in the pool.
