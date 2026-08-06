import assert from 'node:assert/strict';
import test from 'node:test';

import { appReducer, createInitialState, DEFAULT_PRESET_SELECTION } from '../src/app-state.ts';
import { evaluateModel } from '../src/model.ts';

test('default state is the resolved 1M available-today preset', () => {
    const state = createInitialState();

    assert.deepEqual(state.preset, DEFAULT_PRESET_SELECTION);
    assert.equal(state.demand.users, 1_000_000);
    assert.equal(state.demand.averageRequestsPerMinutePerUser, 60);
    assert.equal(state.demand.settlementClockSeconds, 300);
    assert.equal(state.inputs.mode, 'channel-v1');
    assert.equal(state.inputs.scheme, 'x402');
    assert.equal(state.inputs.batchSettlementAvailable, false);
    assert.equal(state.inputs.checkpointBatchSize, 1);
    assert.deepEqual(state.activeSimds, []);
    assert.ok(evaluateModel(state.inputs, state.demand).canHandleDemand);
});

test('the canonical default query reloads as selected while other shared URLs remain custom', () => {
    const canonical = createInitialState('?users=1000000&rpm=60&clock=300&method=v1&scheme=x402');
    const custom = createInitialState('?users=10000000&rpm=60&clock=3600&method=v1&scheme=x402');

    assert.deepEqual(canonical.preset, DEFAULT_PRESET_SELECTION);
    assert.equal(custom.preset, null);
});

test('preset toggle sequence is atomic and fastest does not delay the cash sweep', () => {
    let state = createInitialState();
    state = appReducer(state, { objective: 'cheapest', type: 'toggle-preset-objective' });
    assert.equal(state.demand.settlementClockSeconds, 3_600);
    assert.equal(state.preset?.cheapest, true);

    state = appReducer(state, { objective: 'cheapest', type: 'toggle-preset-objective' });
    assert.equal(state.demand.settlementClockSeconds, 300);
    assert.equal(state.preset?.cheapest, false);

    state = appReducer(state, { objective: 'fastest', type: 'toggle-preset-objective' });
    const result = evaluateModel(state.inputs, state.demand);
    assert.equal(state.demand.settlementClockSeconds, 300);
    assert.equal(state.preset?.cheapest, false);
    assert.equal(state.preset?.fastest, true);
    assert.ok(state.inputs.checkpointClockSeconds > 0);
    assert.ok(result.enforceableFinalitySeconds < state.demand.settlementClockSeconds);
});

test('manual edits clear the preset in the same transition', () => {
    const state = appReducer(createInitialState(), {
        key: 'averageTransactionValueUsd',
        type: 'update-demand',
        value: 0.1,
    });

    assert.equal(state.preset, null);
    assert.equal(state.demand.averageTransactionValueUsd, 0.1);
});

test('every preset combination is deterministic, fits, and respects its objective invariants', () => {
    for (const scale of ['1M', '10M'] as const) {
        for (const horizon of ['today', 'longterm'] as const) {
            const select = (cheapest: boolean, fastest: boolean) =>
                appReducer(createInitialState(), {
                    patch: { cheapest, fastest, horizon, scale },
                    type: 'select-preset',
                });
            const neutral = select(false, false);
            const cheapest = select(true, false);
            const fastest = select(false, true);
            const both = select(true, true);
            const neutralResult = evaluateModel(neutral.inputs, neutral.demand);
            const cheapestResult = evaluateModel(cheapest.inputs, cheapest.demand);
            const fastestResult = evaluateModel(fastest.inputs, fastest.demand);
            const bothResult = evaluateModel(both.inputs, both.demand);

            for (const state of [neutral, cheapest, fastest, both]) {
                assert.equal(state.inputs.batchSettlementAvailable, horizon === 'longterm');
                if (horizon === 'today') assert.equal(state.inputs.checkpointBatchSize, 1);
            }

            for (const result of [neutralResult, cheapestResult, fastestResult, bothResult]) {
                assert.ok(result.canHandleDemand, `${scale}/${horizon} preset must fit`);
            }
            assert.ok(cheapestResult.totalOpexUsdPerYear <= neutralResult.totalOpexUsdPerYear);
            assert.ok(fastest.demand.settlementClockSeconds <= neutral.demand.settlementClockSeconds);
            assert.ok(fastestResult.enforceableFinalitySeconds <= neutralResult.enforceableFinalitySeconds);
            assert.ok(bothResult.totalOpexUsdPerYear <= fastestResult.totalOpexUsdPerYear);
            assert.ok(bothResult.enforceableFinalitySeconds <= cheapestResult.enforceableFinalitySeconds);
        }
    }
});
