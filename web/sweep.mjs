import {
    DEFAULT_DEMAND,
    MPP_CHECKPOINT_DEFAULT_BATCH,
    TODAY,
    X402_CHECKPOINT_DEFAULT_BATCH,
    evaluateModel,
    resolvePresetShape,
} from './src/model.ts';

const SCALES = {
    '1M': 1_000_000,
    '10M': 10_000_000,
};

function horizonInputs(horizon, users) {
    if (horizon === 'today') {
        return {
            ...TODAY,
            batchSettlementAvailable: false,
            checkpointBatchSize: 1,
            mode: 'channel-v1',
            scheme: 'x402',
            voucherVerifyPerSecond: users,
        };
    }

    return {
        ...TODAY,
        batchSettlementAvailable: true,
        checkpointBatchSize: MPP_CHECKPOINT_DEFAULT_BATCH,
        largeTx: true,
        mode: 'channel-v2',
        openCostUnits: 17_300,
        scheme: 'mpp',
        voucherSigFeeRemoved: true,
    };
}

function demandFor(users) {
    return {
        ...DEFAULT_DEMAND,
        averageRequestsPerMinutePerUser: 60,
        channelLifetimeSeconds: 604_800,
        users,
    };
}

function line(label, shape) {
    const result = shape.result;
    return `${label.padEnd(9)} cash=${String(shape.settlementClockSeconds).padStart(5)}s checkpoint=${String(shape.checkpointClockSeconds).padStart(5)}s finality=${String(result.settlementLatencySeconds.toFixed(0)).padStart(5)}s budget=${result.budgetSharePercent.toFixed(1).padStart(5)}% all-in=${result.allInTakeRateBps.toFixed(3)}bps opex=$${(result.totalOpexUsdPerYear / 1e6).toFixed(2)}M`;
}

for (const [scale, users] of Object.entries(SCALES)) {
    for (const horizon of ['today', 'longterm']) {
        const inputs = horizonInputs(horizon, users);
        const demand = demandFor(users);
        console.log(`\n### ${scale} | ${horizon}`);
        console.log(line('neither', resolvePresetShape(inputs, demand, { cheapest: false, fastest: false })));
        console.log(line('cheapest', resolvePresetShape(inputs, demand, { cheapest: true, fastest: false })));
        console.log(line('fastest', resolvePresetShape(inputs, demand, { cheapest: false, fastest: true })));
        console.log(line('both', resolvePresetShape(inputs, demand, { cheapest: true, fastest: true })));
    }
}

console.log('\n=== Same-base MPP vs x402 ===');
for (const [scale, users] of Object.entries(SCALES)) {
    const demand = { ...demandFor(users), settlementClockSeconds: 3_600 };
    const base = {
        ...horizonInputs('longterm', users),
        checkpointClockSeconds: 0,
        voucherSigFeeRemoved: false,
    };
    const mpp = evaluateModel({ ...base, checkpointBatchSize: 59, scheme: 'mpp' }, demand);
    const x402 = evaluateModel(
        {
            ...base,
            checkpointBatchSize: 16,
            scheme: 'x402',
            voucherVerifyPerSecond: users,
        },
        demand,
    );
    console.log(
        `${scale}: MPP ${mpp.allInTakeRateBps.toFixed(3)}bps / x402 ${x402.allInTakeRateBps.toFixed(3)}bps; verify delta $${((x402.verifyComputeUsdPerYear - mpp.verifyComputeUsdPerYear) / 1e6).toFixed(2)}M/yr`,
    );
}
