# Constant-Sum Pool Exploit Demonstration

# Overview:
This section demonstrates a constant-sum pool misconfiguration in the protocol, 
illustrating how certain parameter selections can lead to permanent locking of liquidity tokens. 

This PoC is based on the publicly available logic in the protocol but highlights a design flaw, not a permissionless attack.

Note:As mentioned in the README, the full exploit path works on constant-sum pools, but the security team has indicated they will not deploy these pools in production.
As a result, this PoC remains a demo only, demonstrating the underlying invariant assumptions.



Background: Constant-Sum Pool Mechanics

A constant-sum pool enforces the invariant:

𝑥 + 𝑦 = 𝑘

Where x and y are the balances of the two tokens, and k is a constant. 

Unlike a constant-product pool (x * y = k), this pool does not allow price slippage and is highly sensitive to deposits and withdrawals.

Key points:

Invariant assumption: The pool assumes that LP tokens are always redeemable for the underlying assets.
No on-chain guard: The protocol does not validate parameter configurations against the redemption invariant.
Admin-controlled weights: Pool weights or token allocations can be set arbitrarily at creation, which can break the redemption invariant if chosen incorrectly.


Vulnerability Logic

1. Redemption Invariant

The protocol assumes:
```
function redeemLP(address lpHolder) public returns (uint256 amount0, uint256 amount1) {
    uint256 lpBalance = lpBalances[lpHolder];
    require(lpBalance > 0, "No LP tokens");
    
    amount0 = (lpBalance * token0Balance) / totalLPSupply;
    amount1 = (lpBalance * token1Balance) / totalLPSupply;

    // Transfer tokens to user
    token0.transfer(lpHolder, amount0);
    token1.transfer(lpHolder, amount1);

    totalLPSupply -= lpBalance;
    lpBalances[lpHolder] = 0;
}
```

The assumption here is:

```totalLPSupply``` > 0 and the proportional calculation always yields a valid redemption amount.

If ```token0Balance``` or ```token1Balance``` is misconfigured (e.g., set extremely low or zero), the user may receive 0 tokens, permanently locking their LP tokens.



# How Constant-Sum Amplifies the Risk

Constant-sum pools have fixed token ratios:

x+y=k

sppose a pool is misconfigured such that ```token0Balance``` = 0 and ```token1Balance``` = 1000.
A user deposits LP = 100.


The redemption formula calculates:

```
amount0 = (100 * 0) / 100 = 0
amount1 = (100 * 1000) / 100 = 1000
```

If a withdrawal or swap changes balances in a way that ```token0Balance``` < 0 (possible through internal calculations or rounding), 
subsequent LP redemptions cannot satisfy the invariant, locking LP tokens.

This is not an attacker-exploitable bug per se, since the user triggers it themselves, but it demonstrates:

The protocol assumes a safe configuration exists,
No on-chain check prevents unsafe weights.

