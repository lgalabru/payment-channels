import { useEffect, useId, useState } from 'react';

type ModelMode = 'vanilla' | 'channel-v1' | 'channel-v2' | 'x402-batch' | 'mpp-operator';
type TransferKind = 'spl-token' | 'token-2022';

interface ModelInputs {
    availableCapacityPercent: number;
    blockCostUnits: number;
    // Cadence of interim enforceability checkpoints, in seconds; 0 disables them (mode reduces to v2).
    // Only read for x402-batch / mpp-operator.
    checkpointClockSeconds: number;
    // Channel-settles packed into one checkpoint tx (n in the per-mode fit). Only read for checkpoint modes.
    checkpointBatchSize: number;
    // Cost of the `open` instruction in CU. SIMD-0567 (p-ATA) cuts this from 36,086 to ~17,300; feeds the
    // v1 lifecycle and the v2 amortized open. Extracted as an input so timeline SIMDs can move it.
    openCostUnits: number;
    mode: ModelMode;
    reclaimBatchSize: number;
    rentPerChannelSol: number;
    slotMs: number;
    // SIMD-0568 (precompile removal): drops the ed25519 signature fee on voucher-bearing settles, so a
    // channel settle tx pays one base signature instead of two.
    voucherSigFeeRemoved: boolean;
    // SIMD-0296 / 0385 (4kB transactions): raises checkpoint packing — x402 5 → 16/tx, ADR-004 59 → 60.
    largeTx: boolean;
    transferCostUnits: number;
    transferKind: TransferKind;
    voucherVerifyPerSecond: number;
}

interface DemandInputs {
    averageRequestsPerMinutePerUser: number;
    averageTransactionValueUsd: number;
    capitalCostAnnualPercent: number;
    channelLifetimeSeconds: number;
    priorityFeeLamportsPerTx: number;
    settlementClockSeconds: number;
    solPriceUsd: number;
    users: number;
}

interface RangeKnobProps {
    readonly disabled?: boolean;
    readonly format?: (value: number) => string;
    readonly help: string;
    readonly label: string;
    readonly max: number;
    readonly min: number;
    readonly onChange: (value: number) => void;
    readonly step: number;
    readonly value: number;
}

interface DiscreteRangeKnobProps {
    readonly disabled?: boolean;
    readonly format?: (value: number) => string;
    readonly help: string;
    readonly label: string;
    readonly onChange: (value: number) => void;
    readonly options: readonly number[];
    readonly value: number;
}

interface SelectKnobProps {
    readonly disabled?: boolean;
    readonly help: string;
    readonly label: string;
    readonly onChange: (value: number) => void;
    readonly options: readonly { label: string; value: number }[];
    readonly value: number;
}

const TARGET_PAYMENTS_PER_SECOND = 10_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_MONTH = 2_592_000; // 30 days
const SECONDS_PER_YEAR = 31_536_000; // 365 days
const SPL_TOKEN_TRANSFER_COST_UNITS = 1_911;
const TOKEN_2022_TRANSFER_COST_UNITS = 6_536;
const V1_LIFECYCLE_COST_UNITS = 61_622;
const STANDALONE_RECLAIM_COST_UNITS = 1_661;
// ADR-005 channel re-arm (v2, proposed — not implemented). A persistent channel pays a cheap
// rearm+top_up at each session boundary instead of a full open+close+reclaim; the one-time channel
// build/teardown amortizes over K sessions. Planning envelope from docs/005-channel-rearm.md.
const REARM_COST_UNITS = 19_000; // payee+feepayer sigs, ed25519 voucher, 7 locks, distribute-shape exec + refund leg
const TOP_UP_COST_UNITS = 10_200; // 720 + 4 locks + 8,267 measured exec
const SESSION_BOUNDARY_V2_COST_UNITS = REARM_COST_UNITS + TOP_UP_COST_UNITS; // 29,200 per session
// One-time channel build/teardown, paid once per channel life (NOT per session). Over K sessions the
// channel pays: 1 open + (K−1) rearm+top_up boundaries + 1 terminal close (carries the final voucher) +
// 1 batched reclaim. This makes v2(K=1) == v1 exactly (zero re-arms occur) and v2 strictly cheaper for
// K>1. Corrects the earlier flat 58,134/K form, which double-charged the last session for both a re-arm
// and a terminal close (v2 read worse than v1 at K=1). See PR #81 commit d58ad41 and lifecycleCost().
const V2_OPEN_COST_UNITS = 36_086; // baseline `open` cost (default ModelInputs.openCostUnits)
// v1 lifecycle with the `open` instruction factored out, so timeline SIMDs can move open independently.
const V1_LIFECYCLE_EX_OPEN_COST_UNITS = V1_LIFECYCLE_COST_UNITS - V2_OPEN_COST_UNITS; // 25,536
const V2_TERMINAL_CLOSE_COST_UNITS = 23_875; // final settle_and_seal + distribute, carries the last voucher
// Enforceability checkpoints (x402-batch / mpp-operator only). An interim settle that advances the
// on-chain watermark so accumulated voucher value becomes claimable BETWEEN cash-sweep boundaries —
// the "cheap + frequent" plane of the decoupled-cadence design (see ONE_MINUTE_SETTLEMENT.md). Additive
// on top of the v2 lifecycle: with the checkpoint cadence disabled, these modes reduce to plain v2.
// x402: distinct client signer per customer, so each checkpoint packs [Ed25519, settle] pairs, size-bound
// at n ≤ 5 in a 1,232-byte tx (~16 under a 4kB tx). mpp-operator: one operator holds authorizedSigner
// across the fleet, so ADR-004 batches DISTINCT customers into one signed commitment, account-bound at
// n ≤ 59. Per-channel fits from MODES_MPP_X402.md (toly, 2026-08-06).
const X402_CHECKPOINT_TODAY_MAX_BATCH = 5; // 1,232-byte tx limit today
const X402_CHECKPOINT_MAX_BATCH = 16; // under 4kB transactions (SIMD-0296 / 0385)
const X402_CHECKPOINT_DEFAULT_BATCH = 5;
const MPP_CHECKPOINT_MAX_BATCH = 59; // 64-account tx cap, ADR-004
const MPP_CHECKPOINT_LARGETX_MAX_BATCH = 60; // ADR-004 59 → 60 under 4kB transactions
const MPP_CHECKPOINT_DEFAULT_BATCH = 59;
const USER_STEPS = [0, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000] as const;
const SETTLEMENT_CLOCK_OPTIONS = [
    { label: 'Disabled', value: 0 },
    { label: '1s', value: 1 },
    { label: '2s', value: 2 },
    { label: '3s', value: 3 },
    { label: '4s', value: 4 },
    { label: '5s', value: 5 },
    { label: '10s', value: 10 },
    { label: '15s', value: 15 },
    { label: '30s', value: 30 },
    { label: '1m', value: 60 },
    { label: '2m', value: 120 },
    { label: '5m', value: 300 },
    { label: '10m', value: 600 },
    { label: '30m', value: 1_800 },
    { label: '1h', value: 3_600 },
    { label: '2h', value: 7_200 },
    { label: '3h', value: 10_800 },
    { label: '6h', value: 21_600 },
    { label: '12h', value: 43_200 },
    { label: '24h', value: 86_400 },
] as const;

const CHANNEL_LIFETIME_OPTIONS = [
    { label: '5m', value: 300 },
    { label: '10m', value: 600 },
    { label: '30m', value: 1_800 },
    { label: '1h', value: 3_600 },
    { label: '12h', value: 43_200 },
    { label: '1d', value: 86_400 },
    { label: '2d', value: 172_800 },
    { label: '1w', value: 604_800 },
] as const;

const DEFAULT_DEMAND: DemandInputs = {
    averageRequestsPerMinutePerUser: 60,
    averageTransactionValueUsd: 0.05,
    capitalCostAnnualPercent: 8,
    channelLifetimeSeconds: 86_400,
    priorityFeeLamportsPerTx: 0,
    settlementClockSeconds: 60,
    solPriceUsd: 150,
    users: 10_000_000,
};

const TODAY: ModelInputs = {
    availableCapacityPercent: 50,
    blockCostUnits: 100_000_000,
    checkpointBatchSize: X402_CHECKPOINT_DEFAULT_BATCH,
    checkpointClockSeconds: 60,
    largeTx: false,
    mode: 'channel-v1',
    openCostUnits: V2_OPEN_COST_UNITS,
    reclaimBatchSize: 8,
    rentPerChannelSol: 0.00471192,
    slotMs: 400,
    transferCostUnits: SPL_TOKEN_TRANSFER_COST_UNITS,
    transferKind: 'spl-token',
    voucherSigFeeRemoved: false,
    voucherVerifyPerSecond: 1_000_000,
};

// Timeline as non-exclusive, stackable SIMDs. Each toggle applies its own delta to the SIMD-controlled
// subset of ModelInputs, so multiple upgrades compose. Deltas track SIMD_WATCH.md (toly, 2026-08-06).
// Applied in array order — rent ÷2 before rent ÷10 (÷10 supersedes), p-ATA before Alpenglow (bumps stack).
type SimdParams = Pick<
    ModelInputs,
    'availableCapacityPercent' | 'blockCostUnits' | 'slotMs' | 'rentPerChannelSol' | 'openCostUnits' | 'voucherSigFeeRemoved' | 'largeTx'
>;
const BASELINE_RENT_SOL = 0.00471192;
const BASELINE_SIMD_PARAMS: SimdParams = {
    availableCapacityPercent: 50,
    blockCostUnits: 100_000_000,
    largeTx: false,
    openCostUnits: V2_OPEN_COST_UNITS,
    rentPerChannelSol: BASELINE_RENT_SOL,
    slotMs: 400,
    voucherSigFeeRemoved: false,
};

interface Simd {
    readonly id: string;
    readonly code: string;
    readonly label: string;
    readonly est: string;
    readonly status: string;
    readonly moves: string;
    readonly note: string;
    readonly cuNeutral?: boolean;
    readonly warn?: boolean;
    readonly apply: (params: SimdParams) => SimdParams;
}

const SIMDS: readonly Simd[] = [
    {
        apply: params => ({
            ...params,
            availableCapacityPercent: Math.min(100, params.availableCapacityPercent * 1.1),
            openCostUnits: 17_300,
        }),
        code: 'SIMD-0567',
        est: '~mid-2027',
        id: 'p-ata',
        label: 'p-ATA',
        moves: 'open cost · availability',
        note: 'Pinocchio ATA rewrite at the same address: Create 22,940 → 4,171 CU, so open drops 36,086 → ~17,300 and v1 lifecycle ~−31%. Projects ~10% cluster-wide CU headroom (availability ticks up). The one filed proposal that moves this page’s verdicts.',
        status: 'Review',
    },
    {
        apply: params => ({ ...params, voucherSigFeeRemoved: true }),
        code: 'SIMD-0568',
        est: 'after 0565 + migration',
        id: 'precompile',
        label: 'Precompile removal',
        moves: 'fees · packing',
        note: 'Removes the ed25519 precompile: the voucher-settle signature fee halves (10,000 → 5,000 lamports/settle) and the 162-byte ed25519 instruction leaves every settle (naive packing ~2×). ⚠ Mandatory program migration to in-program verify — the only item here that can break the deployed program, not just improve it.',
        status: 'Review',
        warn: true,
    },
    {
        apply: params => ({ ...params, rentPerChannelSol: BASELINE_RENT_SOL * 0.5 }),
        code: 'SIMD-0436',
        est: 'first realistic step',
        id: 'rent-half',
        label: 'Rent ÷2',
        moves: 'float',
        note: 'lamports_per_byte 6,960 → 3,480: rent per channel 0.00471 → 0.00236 SOL. The realistic near-term rent step.',
        status: 'Idea',
    },
    {
        apply: params => ({ ...params, rentPerChannelSol: BASELINE_RENT_SOL * 0.1 }),
        code: 'SIMD-0437',
        est: 'aspirational end-state',
        id: 'rent-tenth',
        label: 'Rent ÷10',
        moves: 'float',
        note: 'Incremental path to ÷10: rent per channel → 0.000471 SOL. Aspirational — 0392/0438 contemplate rent going up, so don’t treat ÷10 as destiny. Supersedes ÷2 when both are on.',
        status: 'Idea',
    },
    {
        apply: params => ({ ...params, largeTx: true }),
        code: 'SIMD-0296 / 0385',
        est: 'Q3 2026 target',
        id: 'large-tx',
        label: '4kB transactions',
        moves: 'packing',
        note: 'Raw 4kB txs over QUIC / Transaction V1: x402 checkpoint packing 5 → 16/tx; ADR-004 59 → 60 (account-bound). A packing multiplier, not a CU/s multiplier — gates the x402 batch knob so the today-preset can’t claim Q3 packing.',
        status: 'Review',
    },
    {
        apply: params => ({ ...params, blockCostUnits: 50_000_000, slotMs: 200 }),
        code: 'SIMD-0525',
        cuNeutral: true,
        est: 'phased',
        id: '200ms-slots',
        label: '200ms slots',
        moves: 'latency only',
        note: 'Slots 400 → 200ms with 50M-CU blocks (Agave slot_params). CU/s is preserved at ~250M, not doubled — a latency phase, no capacity credit.',
        status: 'Draft',
    },
    {
        apply: params => ({ ...params, availableCapacityPercent: Math.min(100, params.availableCapacityPercent + 2) }),
        code: 'SIMD-0326',
        est: 'Agave 4.3 target',
        id: 'alpenglow',
        label: 'Alpenglow',
        moves: 'latency · small availability',
        note: '~150ms finality; vote transactions leave the blocks (low-single-digit % of block CUs). A latency/finality phase with a small availability bump, not a capacity multiplier.',
        status: 'Review',
    },
];

const MODE_LABELS: Readonly<Record<ModelMode, string>> = {
    'channel-v1': 'Payment channel v1',
    'channel-v2': 'Payment channel v2',
    'mpp-operator': 'MPP voucher (operator-signed)',
    vanilla: 'Vanilla transfer',
    'x402-batch': 'x402 batch settlement',
};

// The settlement selector is a two-tier "stack": a base rail (vanilla / channel v1 / channel v2) and,
// for channels, an optional settlement scheme (x402 client-signed batch, or MPP operator-signed sessions).
// The scheme is the OFF-CHAIN voucher plane; x402-batch and mpp-operator are both modeled on the persistent
// (v2) channel, so choosing a scheme resolves the effective mode onto the v2 base.
type BaseMethod = 'vanilla' | 'v1' | 'v2';
type SettlementScheme = 'none' | 'x402' | 'mpp';
const BASE_METHODS: readonly { id: BaseMethod; label: string; sub: string }[] = [
    { id: 'vanilla', label: 'Vanilla transfer', sub: 'one on-chain tx / payment' },
    { id: 'v1', label: 'Payment channel v1', sub: 'open + close every session' },
    { id: 'v2', label: 'Payment channel v2', sub: 'persistent channel, re-arm per session' },
];
function baseMethodOf(mode: ModelMode): BaseMethod {
    if (mode === 'vanilla') return 'vanilla';
    if (mode === 'channel-v1') return 'v1';
    return 'v2'; // channel-v2, x402-batch, mpp-operator all settle on the persistent v2 channel
}
function schemeOf(mode: ModelMode): SettlementScheme {
    if (mode === 'x402-batch') return 'x402';
    if (mode === 'mpp-operator') return 'mpp';
    return 'none';
}

// x402 batch and MPP operator-signed both settle on-chain like v2 (persistent channel, ADR-005 re-arm);
// they differ only in the OFF-CHAIN voucher plane, below.
const PERSISTENT_CHANNEL_MODES: readonly ModelMode[] = ['channel-v2', 'x402-batch', 'mpp-operator'];
function isPersistentChannel(mode: ModelMode): boolean {
    return PERSISTENT_CHANNEL_MODES.includes(mode);
}
// Client-signed modes need one Ed25519 voucher verified per payment (the off-chain fleet). MPP
// operator-signed mode (mpp-specs #309) inverts this: the operator holds authorizedSigner and signs the
// cumulative vouchers itself, while the client authenticates each request with a reusable bearer proof —
// so there is no per-payment client signature to verify. Vanilla carries no vouchers at all.
function requiresPerPaymentVerify(mode: ModelMode): boolean {
    return mode === 'channel-v1' || mode === 'channel-v2' || mode === 'x402-batch';
}

function formatCompact(value: number, decimals = 1): string {
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: decimals,
        notation: 'compact',
    }).format(value);
}

function formatInteger(value: number): string {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatTakeRate(bps: number): string {
    if (!Number.isFinite(bps)) return '—';
    if (bps >= 1_000) return `${formatCompact(bps / 100, 1)}% of value`;

    return `${bps >= 100 ? bps.toFixed(0) : bps.toFixed(1)} bps`;
}

function formatUsd(value: number): string {
    if (value < 0.01) return `$${value.toFixed(3)}`;

    return new Intl.NumberFormat('en-US', {
        currency: 'USD',
        maximumFractionDigits: 2,
        notation: value >= 1_000 ? 'compact' : 'standard',
        style: 'currency',
    }).format(value);
}

function RangeKnob({
    disabled = false,
    format = formatInteger,
    help,
    label,
    max,
    min,
    onChange,
    step,
    value,
}: RangeKnobProps) {
    const id = useId();

    return (
        <div className="knob" style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
            <div className="knob-heading">
                <label htmlFor={`${id}-range`}>{label}</label>
                <input
                    aria-label={`${label} exact value`}
                    className="number-input"
                    disabled={disabled}
                    max={max}
                    min={min}
                    onChange={event => onChange(Number(event.target.value))}
                    step={step}
                    type="number"
                    value={value}
                />
            </div>
            <input
                disabled={disabled}
                id={`${id}-range`}
                max={max}
                min={min}
                onChange={event => onChange(Number(event.target.value))}
                step={step}
                type="range"
                value={value}
            />
            <div className="knob-meta">
                <span>{help}</span>
                <strong>{format(value)}</strong>
            </div>
        </div>
    );
}

function DiscreteRangeKnob({
    disabled = false,
    format = formatInteger,
    help,
    label,
    onChange,
    options,
    value,
}: DiscreteRangeKnobProps) {
    const id = useId();
    const selectedIndex = Math.max(0, options.indexOf(value));

    return (
        <div className="knob" style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
            <div className="knob-heading">
                <label htmlFor={`${id}-range`}>{label}</label>
                <output htmlFor={`${id}-range`}>{format(value)}</output>
            </div>
            <input
                disabled={disabled}
                id={`${id}-range`}
                max={options.length - 1}
                min={0}
                onChange={event => onChange(options[Number(event.target.value)] ?? options[0])}
                step={1}
                type="range"
                value={selectedIndex}
            />
            <div className="knob-meta">
                <span>{help}</span>
                <strong>{format(value)}</strong>
            </div>
        </div>
    );
}

function SelectKnob({ disabled = false, help, label, onChange, options, value }: SelectKnobProps) {
    const id = useId();

    return (
        <div
            className="knob select-knob"
            style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
        >
            <label htmlFor={id}>{label}</label>
            <select disabled={disabled} id={id} onChange={event => onChange(Number(event.target.value))} value={value}>
                {options.map(option => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <div className="knob-meta">
                <span>{help}</span>
                <strong>{options.find(option => option.value === value)?.label}</strong>
            </div>
        </div>
    );
}

function reclaimCostPerChannel(batchSize: number): number {
    return 617 + 1_044 / batchSize;
}

function isCheckpointMode(mode: ModelMode): boolean {
    return mode === 'x402-batch' || mode === 'mpp-operator';
}

/**
 * Largest number of channel-settles that pack into one checkpoint tx for the given mode. x402 is size-bound
 * (5 today, 16 under 4kB txs); mpp-operator is account-bound via ADR-004 (59, 60 under 4kB). `largeTx`
 * reflects SIMD-0296 / 0385 being active on the timeline.
 */
function checkpointMaxBatch(mode: ModelMode, largeTx: boolean): number {
    if (mode === 'mpp-operator') return largeTx ? MPP_CHECKPOINT_LARGETX_MAX_BATCH : MPP_CHECKPOINT_MAX_BATCH;
    return largeTx ? X402_CHECKPOINT_MAX_BATCH : X402_CHECKPOINT_TODAY_MAX_BATCH;
}

/**
 * Scheduler cost of one enforceability checkpoint, per channel, at batch size `n`.
 * x402-batch packs [Ed25519, settle] pairs (client signer per customer); mpp-operator batches distinct
 * customers under one operator signer via ADR-004. Fits from MODES_MPP_X402.md. Non-checkpoint modes: 0.
 */
function checkpointCostPerChannel(mode: ModelMode, batchSize: number): number {
    const n = Math.max(1, batchSize);
    if (mode === 'x402-batch') return 3_166 + 1_043 / n;
    if (mode === 'mpp-operator') return 890 + 3_420 / n;
    return 0;
}

/** Scheduler cost of one settlement boundary (one session). `sessionsPerChannel` (K) only matters for v2. */
function lifecycleCost(inputs: ModelInputs, sessionsPerChannel: number): number {
    const reclaim = reclaimCostPerChannel(inputs.reclaimBatchSize);
    if (inputs.mode === 'channel-v1') {
        // Full teardown/rebuild every session: open + settle_and_seal+distribute + (batched) reclaim.
        // `open` is factored out so a timeline SIMD (p-ATA) can move it independently of the rest.
        return V1_LIFECYCLE_EX_OPEN_COST_UNITS + inputs.openCostUnits - STANDALONE_RECLAIM_COST_UNITS + reclaim;
    }

    // ADR-005: over K = sessionsPerChannel sessions the channel pays one open, (K−1) cheap rearm+top_up
    // boundaries, one terminal close carrying the final voucher, and one batched reclaim:
    //   [open + (K−1)·boundary + close + reclaim] / K  =  boundary + (open + close + reclaim − boundary)/K
    // At K=1 this equals v1 exactly (the terminal close replaces the only boundary; zero re-arms occur);
    // for K>1 it is strictly cheaper. Reclaim stays batch-dependent so the K=1 == v1 invariant holds for
    // every reclaim-batch value, not just the observed 8.
    const channelOnceOffOverhead =
        inputs.openCostUnits + V2_TERMINAL_CLOSE_COST_UNITS + reclaim - SESSION_BOUNDARY_V2_COST_UNITS;
    return SESSION_BOUNDARY_V2_COST_UNITS + channelOnceOffOverhead / Math.max(1, sessionsPerChannel);
}

type ArrivingDemandKey = 'averageRequestsPerMinutePerUser' | 'users';

function arrivingRequestsPerSecond(demand: DemandInputs): number {
    return (demand.users * demand.averageRequestsPerMinutePerUser) / 60;
}

function clampArrivingDemand(previous: DemandInputs, key: ArrivingDemandKey, proposedValue: number): DemandInputs {
    const currentValue = previous[key];
    const candidate = { ...previous, [key]: proposedValue };
    const candidateRate = arrivingRequestsPerSecond(candidate);

    // Decreases are always allowed, including recovery from state created before this clamp existed.
    if (proposedValue <= currentValue || candidateRate <= TARGET_PAYMENTS_PER_SECOND) return candidate;

    if (key === 'users') {
        if (previous.averageRequestsPerMinutePerUser === 0) return candidate;

        const maximumUsers = Math.floor((TARGET_PAYMENTS_PER_SECOND * 60) / previous.averageRequestsPerMinutePerUser);
        const users = USER_STEPS.reduce(
            (closest, option) => (option <= Math.min(proposedValue, maximumUsers) ? option : closest),
            USER_STEPS[0],
        );
        return { ...previous, users };
    }

    if (previous.users === 0) return candidate;

    const maximumRequestsPerMinute = Math.floor((TARGET_PAYMENTS_PER_SECOND * 60) / previous.users);
    return {
        ...previous,
        averageRequestsPerMinutePerUser: Math.min(proposedValue, maximumRequestsPerMinute),
    };
}

/** Interactive capacity model backed by the report's measured scheduler costs. */
const QUERY_TO_MODE: Readonly<Record<string, ModelMode>> = {
    mpp: 'mpp-operator',
    v1: 'channel-v1',
    v2: 'channel-v2',
    vanilla: 'vanilla',
    x402: 'x402-batch',
};
const MODE_TO_QUERY: Readonly<Record<ModelMode, string>> = {
    'channel-v1': 'v1',
    'channel-v2': 'v2',
    'mpp-operator': 'mpp',
    vanilla: 'vanilla',
    'x402-batch': 'x402',
};

/** Snap an arbitrary user count to the nearest discrete slider step. */
function nearestUserStep(value: number): number {
    return USER_STEPS.reduce(
        (best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best),
        USER_STEPS[0],
    );
}

/** Seed demand + settlement method from the shareable `?users&rpm&clock&method` query. */
function readSharedParams(): { demand: Partial<DemandInputs>; mode?: ModelMode } {
    const demand: Partial<DemandInputs> = {};
    if (typeof window === 'undefined') return { demand };
    const params = new URLSearchParams(window.location.search);

    const users = Number(params.get('users'));
    if (params.has('users') && Number.isFinite(users)) demand.users = nearestUserStep(Math.max(0, users));

    const rpm = Number(params.get('rpm'));
    if (params.has('rpm') && Number.isFinite(rpm)) {
        demand.averageRequestsPerMinutePerUser = Math.min(500, Math.max(0, Math.round(rpm)));
    }

    const clock = Number(params.get('clock'));
    if (params.has('clock') && SETTLEMENT_CLOCK_OPTIONS.some(option => option.value === clock)) {
        demand.settlementClockSeconds = clock;
    }

    return { demand, mode: QUERY_TO_MODE[params.get('method') ?? ''] };
}

/** Apply a settlement method to model inputs. */
function inputsForMode(base: ModelInputs, mode: ModelMode): ModelInputs {
    return { ...base, mode };
}

export function App() {
    const [inputs, setInputs] = useState<ModelInputs>(() => {
        const { mode } = readSharedParams();
        return mode ? inputsForMode(TODAY, mode) : TODAY;
    });
    const [demand, setDemand] = useState<DemandInputs>(() => ({ ...DEFAULT_DEMAND, ...readSharedParams().demand }));
    const [activeSimds, setActiveSimds] = useState<readonly string[]>([]);
    const [isCustomized, setIsCustomized] = useState(false);

    // Mirror the four shareable knobs into the URL query so any configuration is linkable.
    // Debounced + guarded: dragging a range slider fires an `input` event per pixel, so a single
    // drag can push dozens of updates/second. Browsers rate-limit history.replaceState (Safari
    // ~100/30s, Firefox ~50/10s) and throw a SecurityError past the cap — which, thrown from an
    // effect with no error boundary, unmounts the whole tree and blanks the page. Debouncing
    // collapses a drag into one write when the user pauses; the try/catch is a belt-and-suspenders
    // guard so a throttle error can never crash the app.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handle = window.setTimeout(() => {
            const params = new URLSearchParams();
            params.set('users', String(demand.users));
            params.set('rpm', String(demand.averageRequestsPerMinutePerUser));
            params.set('clock', String(demand.settlementClockSeconds));
            params.set('method', MODE_TO_QUERY[inputs.mode]);
            try {
                window.history.replaceState(
                    null,
                    '',
                    `${window.location.pathname}?${params.toString()}${window.location.hash}`,
                );
            } catch {
                // Browser history rate-limit hit during rapid drags. Safe to skip — the URL
                // resyncs on the next settled change.
            }
        }, 200);
        return () => window.clearTimeout(handle);
    }, [demand, inputs.mode]);

    const blocksPerSecond = 1_000 / inputs.slotMs;
    const nominalBudgetPerSecond = inputs.blockCostUnits * blocksPerSecond;
    const availableBudgetPerSecond = nominalBudgetPerSecond * (inputs.availableCapacityPercent / 100);
    const isChannel = inputs.mode !== 'vanilla';
    const logicalRequestsPerSecond = arrivingRequestsPerSecond(demand);
    const settlementClockEnabled = demand.settlementClockSeconds > 0;
    // Offer only lifetimes ≥ the active settlement clock — a channel can't be shorter than one session.
    const channelLifetimeOptions = settlementClockEnabled
        ? CHANNEL_LIFETIME_OPTIONS.filter(option => option.value >= demand.settlementClockSeconds)
        : CHANNEL_LIFETIME_OPTIONS;
    // One channel = one session. It accumulates cumulative vouchers off-chain, then makes exactly ONE
    // on-chain settle_and_seal + distribute when the session idle-closes — this is how MPP `session` and
    // x402 `upto` actually settle (see the program lifecycle). So payments-per-channel is DERIVED from the
    // session window and the request rate; it is not a free knob, and it is ultimately capped by the escrow
    // deposit divided by the payment value.
    const requestsPerSettlement = isChannel
        ? settlementClockEnabled
            ? Math.max(1, (demand.averageRequestsPerMinutePerUser * demand.settlementClockSeconds) / 60)
            : 1
        : 1;
    const paymentsPerChannel = requestsPerSettlement;

    // Session length = how long a channel accumulates vouchers before its settlement boundary.
    const channelLifeSeconds = settlementClockEnabled
        ? demand.settlementClockSeconds
        : demand.averageRequestsPerMinutePerUser > 0
          ? 60 / demand.averageRequestsPerMinutePerUser
          : Infinity;
    // K = sessions per channel. v1 tears down each session (K=1 effectively); ADR-005 v2 keeps the channel
    // alive across the whole lifetime, so its build/teardown amortizes over lifetime ÷ session clock.
    const sessionsPerChannel = settlementClockEnabled
        ? Math.max(1, demand.channelLifetimeSeconds / demand.settlementClockSeconds)
        : 1;

    // Enforceability checkpoints (x402-batch / mpp-operator only). A separate, typically FASTER cadence than
    // the cash-sweep clock above: each live channel posts one interim settle per checkpoint window to make
    // its accumulated voucher value claimable early. This is additive on-chain cost on top of the v2
    // lifecycle; with the cadence disabled it contributes nothing and the mode is exactly v2. mpp-operator
    // batches distinct customers under one operator signer (ADR-004, ~948 CU/ch); x402 packs per-customer
    // [Ed25519, settle] pairs (~3,375 CU/ch at n=5) — so mpp is strictly cheaper here at equal demand.
    const checkpointsEnabled = isCheckpointMode(inputs.mode) && inputs.checkpointClockSeconds > 0;
    const checkpointChannels = isChannel ? demand.users : 0;
    const checkpointCostPerChannelUnits = checkpointsEnabled
        ? checkpointCostPerChannel(inputs.mode, inputs.checkpointBatchSize)
        : 0;
    const checkpointsPerSecond = checkpointsEnabled ? checkpointChannels / inputs.checkpointClockSeconds : 0;
    const checkpointCostUnitsPerSecond = checkpointsPerSecond * checkpointCostPerChannelUnits;
    // n channel-settles pack into one physical checkpoint tx.
    const checkpointTransactionsPerSecond = checkpointsEnabled
        ? checkpointsPerSecond / Math.max(1, inputs.checkpointBatchSize)
        : 0;

    // Cost of one settlement boundary (one session), then amortized over the payments that session carried.
    const costPerLifecycle = isChannel ? lifecycleCost(inputs, sessionsPerChannel) : inputs.transferCostUnits;
    const costPerLogicalPayment = isChannel ? costPerLifecycle / paymentsPerChannel : inputs.transferCostUnits;

    // Checkpoints claim a fixed slice of the scheduler budget (they scale with live channels + cadence, not
    // with the payment lifecycle), so payment throughput is bounded by what's LEFT after checkpoints.
    const budgetForPaymentsPerSecond = Math.max(0, availableBudgetPerSecond - checkpointCostUnitsPerSecond);
    const maximumPaymentsPerSecond = costPerLogicalPayment > 0 ? budgetForPaymentsPerSecond / costPerLogicalPayment : 0;
    // Off-chain voucher plane: every logical payment is a voucher the session service must Ed25519-verify.
    // Vanilla transfers carry no vouchers, so only the on-chain ceiling applies there.
    const perPaymentVerify = requiresPerPaymentVerify(inputs.mode);
    const voucherVerifyCeiling = perPaymentVerify ? inputs.voucherVerifyPerSecond : Infinity;
    // A path sustains only as fast as its tightest stage: on-chain execution or off-chain verification.
    const sustainableCeiling = Math.min(maximumPaymentsPerSecond, voucherVerifyCeiling);
    const progressPercent = Math.min(100, (logicalRequestsPerSecond / TARGET_PAYMENTS_PER_SECOND) * 100);
    // Requests the selected path can actually sustain: demand capped by the tightest ceiling.
    const processedRequestsPerSecond = Math.min(logicalRequestsPerSecond, sustainableCeiling);
    const processedPercent = Math.min(100, (processedRequestsPerSecond / TARGET_PAYMENTS_PER_SECOND) * 100);
    const droppedRequestsPerSecond = Math.max(0, logicalRequestsPerSecond - processedRequestsPerSecond);
    const voucherVerifyBinds = perPaymentVerify && voucherVerifyCeiling < maximumPaymentsPerSecond;
    const bindingConstraint =
        droppedRequestsPerSecond <= 0
            ? 'none'
            : voucherVerifyBinds
              ? 'off-chain Ed25519 voucher verification'
              : 'on-chain execution budget';
    const requiredBudgetPerSecond = logicalRequestsPerSecond * costPerLogicalPayment + checkpointCostUnitsPerSecond;
    const budgetSharePercent =
        availableBudgetPerSecond > 0 ? (requiredBudgetPerSecond / availableBudgetPerSecond) * 100 : 0;
    const checkpointBudgetSharePercent =
        availableBudgetPerSecond > 0 ? (checkpointCostUnitsPerSecond / availableBudgetPerSecond) * 100 : 0;
    const voucherVerifySharePercent = (logicalRequestsPerSecond / voucherVerifyCeiling) * 100;

    // One settlement boundary per session (a settle_and_seal close in v1, a rearm in v2).
    const sessionsPerSecond = isChannel ? logicalRequestsPerSecond / paymentsPerChannel : 0;
    const channelLifecyclesPerSecond = sessionsPerSecond;
    const settlementsPerSecond = sessionsPerSecond;
    // Channel builds+teardowns per second: every session in v1; once per K sessions with ADR-005 re-arm.
    const channelBuildsPerSecond = isPersistentChannel(inputs.mode)
        ? sessionsPerSecond / sessionsPerChannel
        : sessionsPerSecond;
    const physicalTransactionsPerSecond =
        (!isChannel
            ? logicalRequestsPerSecond
            : inputs.mode === 'channel-v1'
              ? sessionsPerSecond + // open
                sessionsPerSecond + // terminal settle_and_seal + distribute
                sessionsPerSecond / inputs.reclaimBatchSize // batched reclaim
              : sessionsPerSecond * 2 + // rearm + top_up per session
                channelBuildsPerSecond * (2 + 1 / inputs.reclaimBatchSize)) + // amortized open + close + batched reclaim
        checkpointTransactionsPerSecond; // interim enforceability settles (checkpoint modes only; else 0)
    const liveChannels = isChannel ? demand.users : 0;
    const rentWorkingCapital = liveChannels * inputs.rentPerChannelSol;
    const grossValuePerSecondUsd = logicalRequestsPerSecond * demand.averageTransactionValueUsd;
    const canHandleDemand = logicalRequestsPerSecond <= sustainableCeiling;

    // Settlement reckoning: rates hide the absolute on-chain work and the time to clear it.
    // Backlog factor >1 means the chain cannot keep up with the OFFERED demand and the queue grows.
    const onChainBacklogFactor = availableBudgetPerSecond > 0 ? requiredBudgetPerSecond / availableBudgetPerSecond : Infinity;
    // A payment cannot settle before its session closes, then must wait out the on-chain drain if over budget.
    const settlementLatencySeconds = isChannel
        ? (Number.isFinite(channelLifeSeconds) ? channelLifeSeconds : 0) * Math.max(1, onChainBacklogFactor)
        : Math.max(1, onChainBacklogFactor) / Math.max(blocksPerSecond, 0.001);
    // On-chain transactions generated over one settlement window, and chain-time to land them.
    const settlementWindowSeconds = isChannel && Number.isFinite(channelLifeSeconds) ? channelLifeSeconds : 1;
    const onChainTxPerWindow = physicalTransactionsPerSecond * settlementWindowSeconds;
    const windowDrainSeconds = settlementWindowSeconds * onChainBacklogFactor;

    // Operating cost: the dollar cost of running the rail at the selected demand. None of this touches
    // the CU capacity math above — it converts the physical on-chain footprint into fees + tied-up capital.
    // Most channel transactions (open/settle/rearm/top_up) carry two signatures (payee + fee payer); vanilla
    // transfers carry one. Base fee is the fixed 5,000 lamports/signature; priority fee is a per-tx knob
    // (0 by default — realistic while blocks sit ~⅓ full, add it to model congestion pricing).
    // Channel txs carry payee + fee-payer signatures (2); voucher-bearing settles also pay an ed25519
    // precompile signature fee. SIMD-0568 removes that precompile, so a settle drops to a single base sig.
    const signaturesPerTransaction = isChannel ? (inputs.voucherSigFeeRemoved ? 1 : 2) : 1;
    const networkFeeLamportsPerSecond =
        physicalTransactionsPerSecond *
        (signaturesPerTransaction * BASE_FEE_LAMPORTS_PER_SIGNATURE + demand.priorityFeeLamportsPerTx);
    const networkFeeSolPerSecond = networkFeeLamportsPerSecond / LAMPORTS_PER_SOL;
    const networkFeeUsdPerSecond = networkFeeSolPerSecond * demand.solPriceUsd;
    const feeTakeRateBps = grossValuePerSecondUsd > 0 ? (networkFeeUsdPerSecond / grossValuePerSecondUsd) * 10_000 : 0;
    const vanillaNetworkFeeUsdPerSecond =
        ((logicalRequestsPerSecond * (BASE_FEE_LAMPORTS_PER_SIGNATURE + demand.priorityFeeLamportsPerTx)) /
            LAMPORTS_PER_SOL) *
        demand.solPriceUsd;
    const vanillaFeeTakeRateBps =
        grossValuePerSecondUsd > 0 ? (vanillaNetworkFeeUsdPerSecond / grossValuePerSecondUsd) * 10_000 : 0;
    const networkFeeMultiplier =
        networkFeeUsdPerSecond > 0 ? vanillaNetworkFeeUsdPerSecond / networkFeeUsdPerSecond : Infinity;
    const networkFeeSavingsUsdPerDay = Math.max(
        0,
        (vanillaNetworkFeeUsdPerSecond - networkFeeUsdPerSecond) * SECONDS_PER_DAY,
    );

    // Working capital tied up (refundable, not burned): channel + escrow rent, plus the escrow float —
    // value accumulated within one settlement window before it settles on-chain and the deposit refreshes.
    const rentWorkingCapitalUsd = rentWorkingCapital * demand.solPriceUsd;
    const escrowFloatUsd = isChannel ? grossValuePerSecondUsd * settlementWindowSeconds : 0;
    const workingCapitalUsd = rentWorkingCapitalUsd + escrowFloatUsd;
    const capitalCarryingCostUsdPerYear = workingCapitalUsd * (demand.capitalCostAnnualPercent / 100);

    // All-in operating cost: fees (a burn) + the carrying cost of the refundable capital held in the rail.
    const feeUsdPerYear = networkFeeUsdPerSecond * SECONDS_PER_YEAR;
    const totalOpexUsdPerYear = feeUsdPerYear + capitalCarryingCostUsdPerYear;
    const allInTakeRateBps =
        grossValuePerSecondUsd > 0 ? (totalOpexUsdPerYear / (grossValuePerSecondUsd * SECONDS_PER_YEAR)) * 10_000 : 0;

    const updateInput = <Key extends keyof ModelInputs>(key: Key, value: ModelInputs[Key]) => {
        setInputs(previous => ({ ...previous, [key]: value }));
        setIsCustomized(true);
    };

    const updateDemand = <Key extends keyof DemandInputs>(key: Key, value: DemandInputs[Key]) => {
        setDemand(previous => ({ ...previous, [key]: value }));
    };

    const updateArrivingDemand = (key: ArrivingDemandKey, value: number) => {
        setDemand(previous => clampArrivingDemand(previous, key, value));
    };

    // A channel cannot be shorter than one of its own sessions, so raising the settlement clock past the
    // current channel lifetime bumps the lifetime up to the smallest option that still contains the clock.
    // Keeps K ≥ 1 meaningful and makes the K=1 corner reachable only at lifetime == clock (where v2 == v1).
    const updateSettlementClock = (clockSeconds: number) => {
        setDemand(previous => {
            if (clockSeconds > 0 && previous.channelLifetimeSeconds < clockSeconds) {
                const bumped = CHANNEL_LIFETIME_OPTIONS.find(option => option.value >= clockSeconds);
                if (bumped) {
                    return { ...previous, channelLifetimeSeconds: bumped.value, settlementClockSeconds: clockSeconds };
                }
            }
            return { ...previous, settlementClockSeconds: clockSeconds };
        });
    };

    // Toggle a timeline SIMD, then recompute the SIMD-controlled inputs from baseline by stacking every
    // active SIMD's delta in array order. Non-SIMD fields (mode, checkpoint cadence, reclaim batch, etc.)
    // are preserved; the checkpoint batch is clamped to whatever the new packing regime allows.
    const toggleSimd = (id: string) => {
        const next = activeSimds.includes(id) ? activeSimds.filter(other => other !== id) : [...activeSimds, id];
        const params = SIMDS.reduce<SimdParams>(
            (accumulated, simd) => (next.includes(simd.id) ? simd.apply(accumulated) : accumulated),
            { ...BASELINE_SIMD_PARAMS },
        );
        setActiveSimds(next);
        setInputs(previous => {
            const merged = { ...previous, ...params };
            return {
                ...merged,
                checkpointBatchSize: Math.min(merged.checkpointBatchSize, checkpointMaxBatch(merged.mode, merged.largeTx)),
            };
        });
        setIsCustomized(false);
    };

    const selectMode = (mode: ModelMode) => {
        if (mode === inputs.mode) return;

        const transferCostUnits =
            inputs.transferKind === 'spl-token' ? SPL_TOKEN_TRANSFER_COST_UNITS : TOKEN_2022_TRANSFER_COST_UNITS;
        // Reset the checkpoint batch to the target mode's natural default (x402 packs 5 under a 1,232-byte
        // tx; mpp-operator packs 59 distinct customers under ADR-004). Non-checkpoint modes ignore it, so
        // leave it untouched for them.
        const checkpointBatchSize = isCheckpointMode(mode)
            ? mode === 'mpp-operator'
                ? MPP_CHECKPOINT_DEFAULT_BATCH
                : X402_CHECKPOINT_DEFAULT_BATCH
            : inputs.checkpointBatchSize;
        setInputs(previous => ({ ...previous, checkpointBatchSize, mode, transferCostUnits }));
        setIsCustomized(true);
    };

    const activeBaseMethod = baseMethodOf(inputs.mode);
    const activeScheme = schemeOf(inputs.mode);

    // Base rail: vanilla / v1 / v2. Selecting a base drops any settlement scheme (a plain rail).
    const selectBaseMethod = (base: BaseMethod) => {
        selectMode(base === 'vanilla' ? 'vanilla' : base === 'v1' ? 'channel-v1' : 'channel-v2');
    };
    // Settlement scheme: x402 (client-signed) or MPP (operator-signed). Both are v2-persistent constructs,
    // so selecting one promotes the base to v2; clicking the active scheme again collapses back to plain v2.
    const selectScheme = (scheme: 'x402' | 'mpp') => {
        const target: ModelMode = scheme === 'x402' ? 'x402-batch' : 'mpp-operator';
        selectMode(activeScheme === scheme ? 'channel-v2' : target);
    };

    const selectTransferKind = (transferKind: TransferKind) => {
        const transferCostUnits =
            transferKind === 'spl-token' ? SPL_TOKEN_TRANSFER_COST_UNITS : TOKEN_2022_TRANSFER_COST_UNITS;
        setInputs(previous => ({ ...previous, transferCostUnits, transferKind }));
        setIsCustomized(true);
    };

    return (
        <main className="app-shell">
            <header className="hero">
                <div>
                    <p className="eyebrow">
                        <a href="https://github.com/solana-foundation/payment-channels" target="_blank" rel="noopener noreferrer" style={{ color: 'white', textDecoration: 'none' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="white" style={{ display: 'inline-block', marginRight: '6px', verticalAlign: 'text-bottom' }}>
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v 3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                            </svg>
                            SOLANA-FOUNDATION/PAYMENT-CHANNELS
                        </a>
                    </p>
                    <h1>Roadmap to 10M payments / sec</h1>
                    <p className="lede">
                        Compare physical transfers with amortized payment channels. Every preset is editable; every
                        number is a planning ceiling, not a throughput claim.
                    </p>
                </div>
                <div className="target-chip">
                    <span>Target</span>
                    <strong>10,000,000</strong>
                    <small>logical requests / second</small>
                </div>
            </header>

            <section aria-labelledby="timeline-title" className="panel timeline-panel">
                <div className="section-heading">
                    <div>
                        <p className="section-index">01</p>
                        <h2 id="timeline-title">Upgrade timeline</h2>
                    </div>
                    <p>Toggle in-flight SIMDs — they stack. Each moves a specific knob below.</p>
                </div>
                <div className="simd-grid">
                    {SIMDS.map(simd => {
                        const on = activeSimds.includes(simd.id);
                        return (
                            <label className={`simd-card ${on ? 'simd-on' : ''} ${simd.warn ? 'simd-warn' : ''}`} key={simd.id}>
                                <span className="simd-card-top">
                                    <input checked={on} onChange={() => toggleSimd(simd.id)} type="checkbox" />
                                    <span className="simd-code">{simd.code}</span>
                                    <span className="simd-status">{simd.status}</span>
                                </span>
                                <strong>
                                    {simd.label}
                                    {simd.cuNeutral && <span className="simd-tag">CU/s unchanged</span>}
                                </strong>
                                <span className="simd-moves">
                                    {simd.moves} · {simd.est}
                                </span>
                                <small>{simd.note}</small>
                            </label>
                        );
                    })}
                </div>
                <div className="phase-summary" aria-live="polite">
                    <div>
                        <span>
                            {isCustomized
                                ? 'Custom scenario'
                                : activeSimds.length
                                  ? `${activeSimds.length} SIMD${activeSimds.length === 1 ? '' : 's'} stacked`
                                  : 'Today — mainnet baseline'}
                        </span>
                        <strong>
                            {activeSimds.length
                                ? SIMDS.filter(simd => activeSimds.includes(simd.id))
                                      .map(simd => simd.label)
                                      .join(' + ')
                                : 'No upgrades applied'}
                        </strong>
                    </div>
                    <p>
                        No filed SIMD raises CU/s past ~250M — every gain here cuts per-operation cost, not the block
                        ceiling. If a 150M/200M-block proposal appears it multiplies every ceiling on this page
                        linearly; that is the number to watch the SIMD repo for.
                    </p>
                    {isCustomized && <span className="custom-badge">Modified</span>}
                </div>
            </section>

            <section aria-labelledby="progress-title" className="panel progress-panel">
                <div className="progress-heading">
                    <div>
                        <p className="section-index">02</p>
                        <h2 id="progress-title">Demand to 10M</h2>
                    </div>
                    <div className="progress-number">
                        <strong>{formatInteger(logicalRequestsPerSecond)}</strong>
                        <span>/ 10,000,000 requests/s</span>
                    </div>
                </div>
                <div className="demand-controls">
                    <DiscreteRangeKnob
                        format={formatCompact}
                        help="Concurrent users or agents making paid requests"
                        label="Payers (users / agents)"
                        onChange={value => updateArrivingDemand('users', value)}
                        options={USER_STEPS}
                        value={demand.users}
                    />
                    <RangeKnob
                        format={value => `${formatInteger(value)} RPM`}
                        help="Average paid requests per minute per payer"
                        label="Avg RPM/payer"
                        max={500}
                        min={0}
                        onChange={value => updateArrivingDemand('averageRequestsPerMinutePerUser', value)}
                        step={1}
                        value={demand.averageRequestsPerMinutePerUser}
                    />
                    <SelectKnob
                        disabled={inputs.mode === 'vanilla'}
                        help="Session window: how long a channel batches vouchers before its single settle + close. Disabled settles every voucher on-chain."
                        label="Batch settlement clock"
                        onChange={updateSettlementClock}
                        options={SETTLEMENT_CLOCK_OPTIONS}
                        value={demand.settlementClockSeconds}
                    />
                </div>
                <div className="settlement-method-heading">
                    <strong>Settlement stack</strong>
                    <span>Pick a base rail, then optionally a settlement scheme on top.</span>
                </div>
                <div className="settlement-stack">
                    <div aria-label="Base settlement rail" className="mode-switch progress-mode-switch stack-base" role="group">
                        {BASE_METHODS.map(base => (
                            <button
                                aria-pressed={activeBaseMethod === base.id}
                                className={activeBaseMethod === base.id ? 'active' : ''}
                                key={base.id}
                                onClick={() => selectBaseMethod(base.id)}
                                type="button"
                            >
                                <span>{base.label}</span>
                                <small>{base.sub}</small>
                            </button>
                        ))}
                    </div>
                    <div
                        aria-label="Settlement scheme"
                        className={`mode-switch progress-mode-switch stack-scheme ${activeBaseMethod === 'vanilla' ? 'stack-scheme-disabled' : ''}`}
                        role="group"
                    >
                        <button
                            aria-pressed={activeScheme === 'x402'}
                            className={activeScheme === 'x402' ? 'active' : ''}
                            disabled={activeBaseMethod === 'vanilla'}
                            onClick={() => selectScheme('x402')}
                            type="button"
                        >
                            <span>x402</span>
                            <small>batch-settlement, client signed.</small>
                        </button>
                        <button
                            aria-pressed={activeScheme === 'mpp'}
                            className={activeScheme === 'mpp' ? 'active' : ''}
                            disabled={activeBaseMethod === 'vanilla'}
                            onClick={() => selectScheme('mpp')}
                            type="button"
                        >
                            <span>MPP</span>
                            <small><strong>sessions</strong>, operator signed</small>
                        </button>
                    </div>
                </div>
                <div className="progress-scale">
                    <span>0</span>
                    <strong>
                        {droppedRequestsPerSecond > 0
                            ? `${formatCompact(droppedRequestsPerSecond, 2)} req/s dropped`
                            : 'Fully processed'}
                    </strong>
                    <span>10M</span>
                </div>
                <div
                    aria-label={`${formatInteger(logicalRequestsPerSecond)} requests per second arriving, ${formatInteger(processedRequestsPerSecond)} sustained on-chain, toward ten million`}
                    className="dual-progress"
                    role="img"
                >
                    <div className="dual-progress-arriving" style={{ width: `${progressPercent}%` }} />
                    <div className="dual-progress-processed" style={{ width: `${processedPercent}%` }} />
                </div>
                <div className="progress-legend">
                    <span className="legend-processed">
                        <i />
                        Processed {formatCompact(processedRequestsPerSecond, 2)} req/s (
                        {formatPercent(processedPercent)})
                    </span>
                    <span className="legend-arriving">
                        <i />
                        Arriving {formatCompact(logicalRequestsPerSecond, 2)} req/s ({formatPercent(progressPercent)})
                    </span>
                </div>
                <div className="capacity-equation">
                    <span>Logical demand</span>
                    <strong>
                        {formatCompact(demand.users, 2)} payers × {formatInteger(demand.averageRequestsPerMinutePerUser)}{' '}
                        paid req/payer/min ÷ 60 = {formatCompact(logicalRequestsPerSecond, 2)} req/s
                    </strong>
                    <small>
                        {isChannel
                            ? settlementClockEnabled
                                ? `A ${formatCompact(demand.settlementClockSeconds, 2)}s session carries ${formatCompact(paymentsPerChannel, 2)} payments/channel (derived, not chosen), so one ${formatInteger(costPerLifecycle)}-unit lifecycle amortizes to ${formatCompact(costPerLogicalPayment, 2)} units/payment; ${formatCompact(channelLifecyclesPerSecond, 2)} channels open+settle+close per second.`
                                : 'Settlement clock disabled: one payment per channel, so every payment pays a full channel lifecycle — channels only amortize with a session window.'
                            : 'Vanilla always sends one token transfer per request; the settlement clock applies only to payment channels.'}
                    </small>
                </div>
                <div className="capacity-equation">
                    <span>Execution capacity</span>
                    <strong>
                        {formatCompact(inputs.blockCostUnits, 2)} CU/block × {blocksPerSecond.toFixed(1)} blocks/s ={' '}
                        {formatCompact(nominalBudgetPerSecond, 2)} CU/s
                    </strong>
                    <small>
                        {formatPercent(inputs.availableCapacityPercent)} is available to this workload, giving a{' '}
                        {formatCompact(maximumPaymentsPerSecond, 2)} req/s ceiling for the selected path
                        {isChannel ? ` at ${formatInteger(paymentsPerChannel)} payments/channel` : ''}.
                    </small>
                </div>
                {isChannel && perPaymentVerify && (
                    <div className="capacity-equation">
                        <span>Voucher plane</span>
                        <strong>{formatCompact(voucherVerifyCeiling, 2)} Ed25519 verifications/s</strong>
                        <small>
                            Client-signed: each logical payment is one voucher the session service verifies off-chain.
                            This caps sustained requests independently of the on-chain budget, and does not move with
                            settlement batching or payments/channel — so with heavy on-chain amortization it becomes the
                            binding limit. Sustained throughput = {formatCompact(sustainableCeiling, 2)} req/s (min of the
                            two ceilings).
                        </small>
                    </div>
                )}
                {inputs.mode === 'mpp-operator' && (
                    <div className="capacity-equation">
                        <span>Voucher plane</span>
                        <strong>
                            operator-signed — no per-payment verify
                            <span className="trust-badge" title="The operator signs cumulative vouchers itself; a payer's on-chain protection is the escrow deposit cap plus off-chain dispute, not a per-payment signature.">
                                custodial metering · deposit-bounded
                            </span>
                        </strong>
                        <small>
                            MPP operator-signed mode (mpp-specs #309): the operator holds the channel&rsquo;s
                            authorizedSigner and signs the cumulative voucher itself, so there is no client Ed25519 to
                            verify per request. Per-request auth is a reusable bearer proof (a cheap symmetric check),
                            and the operator signs just one voucher per settlement (~{formatCompact(settlementsPerSecond, 2)}/s).
                            The off-chain Ed25519 fleet no longer binds — the ceiling reverts to the on-chain budget.
                            Trade-off: the client trusts the operator&rsquo;s metering, bounded by the escrow deposit
                            (the operator can sign any cumulative amount up to <code>deposit</code>), rather than
                            authorizing each increment with its own signature.
                        </small>
                    </div>
                )}
                {isCheckpointMode(inputs.mode) && checkpointsEnabled && (
                    <div className="capacity-equation">
                        <span>Enforceability checkpoints</span>
                        <strong>
                            {formatCompact(checkpointsPerSecond, 2)} settles/s × {formatInteger(checkpointCostPerChannelUnits)}{' '}
                            CU = {formatCompact(checkpointCostUnitsPerSecond, 2)} CU/s ({formatPercent(checkpointBudgetSharePercent)}{' '}
                            of budget)
                        </strong>
                        <small>
                            {inputs.mode === 'mpp-operator'
                                ? `One operator signer means ADR-004 batches ${formatInteger(inputs.checkpointBatchSize)} distinct customers into a single signed settle (n ≤ ${MPP_CHECKPOINT_MAX_BATCH}, account-bound), so each checkpoint is ~${formatInteger(checkpointCostPerChannel('mpp-operator', inputs.checkpointBatchSize))} CU/channel versus ~${formatInteger(checkpointCostPerChannel('x402-batch', X402_CHECKPOINT_DEFAULT_BATCH))} for client-signed — the same enforceability at a fraction of the on-chain cost, with no verify fleet. Interim settles run on top of the cash-sweep boundary; disable the checkpoint cadence to collapse this mode to plain v2.`
                                : `Client-signed vouchers are made enforceable by interim settles that pack [Ed25519, settle] pairs, ${formatInteger(inputs.checkpointBatchSize)}/tx (size-bound at n ≤ ${X402_CHECKPOINT_MAX_BATCH} under a 4kB tx). Distinct customer signers → no ADR-004 batching, so this plane consumes on-chain budget independently of the off-chain verify fleet. Interim settles run on top of the cash-sweep boundary; disable the checkpoint cadence to collapse this mode to plain v2.`}
                        </small>
                    </div>
                )}
                {isChannel && (
                    <div className="capacity-equation">
                        <span>Settlement reckoning</span>
                        <strong>
                            {formatCompact(physicalTransactionsPerSecond, 2)} on-chain tx/s · settle latency ≈{' '}
                            {formatCompact(settlementLatencySeconds, 2)}s
                        </strong>
                        <small>
                            {onChainBacklogFactor > 1.05 ? (
                                <>
                                    Backlog: at the offered {formatCompact(logicalRequestsPerSecond, 2)} req/s the chain
                                    is {formatCompact(onChainBacklogFactor, 2)}× under budget. One{' '}
                                    {formatCompact(settlementWindowSeconds, 2)}s session generates{' '}
                                    {formatCompact(onChainTxPerWindow, 2)} settlement transactions that take{' '}
                                    {formatCompact(windowDrainSeconds, 2)}s of chain-time to land.
                                    <br />
                                    ⚠️ the queue grows without bound, so this rate is not actually settleable.
                                </>
                            ) : (
                                `Settlements clear within the window: a payment finalizes on-chain up to ${formatCompact(settlementLatencySeconds, 2)}s after it is made (one session length). One session generates ${formatCompact(onChainTxPerWindow, 2)} settlement transactions.`
                            )}
                        </small>
                    </div>
                )}
                <div className={`verdict ${canHandleDemand ? 'pass' : ''}`}>
                    <strong>
                        {canHandleDemand
                            ? `${formatCompact(logicalRequestsPerSecond, 2)} req/s fits`
                            : `${formatCompact(logicalRequestsPerSecond / Math.max(sustainableCeiling, 1), 2)}× over the ${bindingConstraint}`}
                    </strong>
                    <span>
                        On-chain uses {formatPercent(budgetSharePercent)} of the available scheduler budget
                        {perPaymentVerify
                            ? `; off-chain uses ${formatPercent(voucherVerifySharePercent)} of the ${formatCompact(voucherVerifyCeiling, 2)} vouchers/s Ed25519 budget`
                            : inputs.mode === 'mpp-operator'
                              ? '; off-chain has no per-payment verification (operator-signed)'
                              : ''}
                        .
                    </span>
                </div>
            </section>

            <section aria-labelledby="assumptions-title" className="panel controls-panel">
                <div className="section-heading">
                    <div>
                        <p className="section-index">03</p>
                        <h2 id="assumptions-title">Model assumptions</h2>
                    </div>
                    <p>Controls for the selected settlement method.</p>
                </div>

                <div className={`knob-sections ${isChannel ? 'channel-knob-sections' : 'vanilla-knob-sections'}`}>
                    <div className="knob-card">
                        <h3>Network capacity</h3>
                        <RangeKnob
                            format={value => `${formatCompact(value)} units`}
                            help="Scheduler limit per slot"
                            label="Block cost limit"
                            max={150_000_000}
                            min={30_000_000}
                            onChange={value => updateInput('blockCostUnits', value)}
                            step={2_500_000}
                            value={inputs.blockCostUnits}
                        />
                        <RangeKnob
                            format={value => `${value}ms`}
                            help="Slot target"
                            label="Slot duration"
                            max={500}
                            min={150}
                            onChange={value => updateInput('slotMs', value)}
                            step={10}
                            value={inputs.slotMs}
                        />
                        <RangeKnob
                            format={formatPercent}
                            help="Budget reserved for this workload"
                            label="Available capacity"
                            max={100}
                            min={10}
                            onChange={value => updateInput('availableCapacityPercent', value)}
                            step={5}
                            value={inputs.availableCapacityPercent}
                        />
                    </div>

                    {inputs.mode === 'vanilla' ? (
                        <div className="knob-card">
                            <h3>Transfer shape</h3>
                            <div className="transfer-toggle" role="group" aria-label="Transfer kind">
                                {(['spl-token', 'token-2022'] as const).map(kind => (
                                    <button
                                        aria-pressed={inputs.transferKind === kind}
                                        className={inputs.transferKind === kind ? 'active' : ''}
                                        key={kind}
                                        onClick={() => selectTransferKind(kind)}
                                        type="button"
                                    >
                                        {kind === 'spl-token' ? 'SPL Token' : 'Token-2022'}
                                    </button>
                                ))}
                            </div>
                            <RangeKnob
                                format={value => `${formatInteger(value)} units`}
                                help="Whole-transaction scheduler cost"
                                label="Cost per transfer"
                                max={30_000}
                                min={500}
                                onChange={value => updateInput('transferCostUnits', value)}
                                step={1}
                                value={inputs.transferCostUnits}
                            />
                            <div className="measurement-note">
                                <span>On-chain sample</span>
                                <p>
                                    SPL Token/USDC measured 1,911 cost units with one signer. Token-2022/PYUSD measured
                                    6,536 with two signers. Both use TransferChecked and existing token accounts.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="knob-card">
                                <h3>Channel economics</h3>
                                <RangeKnob
                                    format={value => `${value.toFixed(9)} SOL`}
                                    help="Refundable channel + escrow rent"
                                    label="Rent per live channel"
                                    max={0.005}
                                    min={0.0004}
                                    onChange={value => updateInput('rentPerChannelSol', value)}
                                    step={0.000000001}
                                    value={inputs.rentPerChannelSol}
                                />
                                {isPersistentChannel(inputs.mode) && (
                                    <SelectKnob
                                        help="ADR-005: how long a channel stays open across sessions before a real teardown"
                                        label="Channel lifetime"
                                        onChange={value => updateDemand('channelLifetimeSeconds', value)}
                                        options={channelLifetimeOptions}
                                        value={demand.channelLifetimeSeconds}
                                    />
                                )}
                                <div className="batch-table">
                                    <div>
                                        <span>Payments / channel (derived)</span>
                                        <strong>{formatCompact(paymentsPerChannel, 2)}</strong>
                                    </div>
                                    <div>
                                        <span>Cost / logical payment</span>
                                        <strong>{formatCompact(costPerLogicalPayment, 2)} units</strong>
                                    </div>
                                    <div>
                                        <span>Session window</span>
                                        <strong>
                                            {Number.isFinite(channelLifeSeconds)
                                                ? `${formatCompact(channelLifeSeconds, 2)} s`
                                                : '∞'}
                                        </strong>
                                    </div>
                                    {isPersistentChannel(inputs.mode) && (
                                        <div>
                                            <span>Sessions / channel (K)</span>
                                            <strong>{formatCompact(sessionsPerChannel, 2)}</strong>
                                        </div>
                                    )}
                                    <div>
                                        <span>{isPersistentChannel(inputs.mode) ? 'Channel builds+teardowns' : 'Channel opens+closes'}</span>
                                        <strong>{formatCompact(channelBuildsPerSecond, 2)} / second</strong>
                                    </div>
                                    <div>
                                        <span>{isPersistentChannel(inputs.mode) ? 'Re-arm rate' : 'Settlement rate'}</span>
                                        <strong>{formatCompact(settlementsPerSecond, 2)} / second</strong>
                                    </div>
                                    <div>
                                        <span>Live channels</span>
                                        <strong>{formatCompact(liveChannels, 2)}</strong>
                                    </div>
                                </div>
                            </div>

                            <div className="knob-card">
                                <h3>Instruction batching</h3>
                                <RangeKnob
                                    format={value => `${value} instructions / tx`}
                                    help="Observed current program batching: 8"
                                    label="Reclaim batch"
                                    max={32}
                                    min={1}
                                    onChange={value => updateInput('reclaimBatchSize', value)}
                                    step={1}
                                    value={inputs.reclaimBatchSize}
                                />
                                {isCheckpointMode(inputs.mode) && (
                                    <>
                                        <SelectKnob
                                            help="Cadence of interim enforceability settles between cash sweeps. Disabled = plain v2 (no checkpoints)."
                                            label="Checkpoint cadence"
                                            onChange={value => updateInput('checkpointClockSeconds', value)}
                                            options={SETTLEMENT_CLOCK_OPTIONS}
                                            value={inputs.checkpointClockSeconds}
                                        />
                                        <RangeKnob
                                            disabled={!checkpointsEnabled}
                                            format={value => `${value} settles / tx`}
                                            help={
                                                inputs.mode === 'mpp-operator'
                                                    ? 'ADR-004: distinct customers under one operator signer, account-bound (≤ 59)'
                                                    : 'Packed [Ed25519, settle] pairs, size-bound (5 today; ≤ 16 under a 4kB tx)'
                                            }
                                            label="Checkpoint batch (n)"
                                            max={checkpointMaxBatch(inputs.mode, inputs.largeTx)}
                                            min={1}
                                            onChange={value => updateInput('checkpointBatchSize', value)}
                                            step={1}
                                            value={inputs.checkpointBatchSize}
                                        />
                                    </>
                                )}
                                <div className="batch-table">
                                    {isPersistentChannel(inputs.mode) ? (
                                        <>
                                            <div>
                                                <span>Re-arm</span>
                                                <strong>{formatInteger(REARM_COST_UNITS)} units / session</strong>
                                            </div>
                                            <div>
                                                <span>Top-up</span>
                                                <strong>{formatInteger(TOP_UP_COST_UNITS)} units / session</strong>
                                            </div>
                                            {isCheckpointMode(inputs.mode) && checkpointsEnabled && (
                                                <>
                                                    <div>
                                                        <span>Checkpoint cost / channel</span>
                                                        <strong>{formatInteger(checkpointCostPerChannelUnits)} units</strong>
                                                    </div>
                                                    <div>
                                                        <span>Checkpoint tx / second</span>
                                                        <strong>{formatCompact(checkpointTransactionsPerSecond, 2)}</strong>
                                                    </div>
                                                </>
                                            )}
                                            <div>
                                                <span>Build+teardown</span>
                                                <strong>once / {formatCompact(sessionsPerChannel, 2)} sessions</strong>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div>
                                                <span>Open</span>
                                                <strong>1 channel / tx</strong>
                                            </div>
                                            <div>
                                                <span>Terminal distribute</span>
                                                <strong>1 channel / tx</strong>
                                            </div>
                                        </>
                                    )}
                                    <div>
                                        <span>{isPersistentChannel(inputs.mode) ? 'Boundary cost / session' : 'Lifecycle cost'}</span>
                                        <strong>{formatInteger(costPerLifecycle)} units / channel</strong>
                                    </div>
                                </div>
                                <p className="batch-caveat">
                                    {inputs.mode === 'channel-v1'
                                        ? 'One channel = one session: open, a single settle_and_seal + distribute at idle-close, and a batched reclaim. Payments/channel is derived from the session window × request rate (capped by escrow deposit ÷ payment value), so longer sessions amortize the fixed open+distribute over more payments. Lengthen the session clock until the verdict fits the target — the crossover scales linearly with it.'
                                        : 'ADR-005 re-arm (proposed, not benchmarked): the channel stays open across sessions, so each session pays only a cheap rearm+top_up (~29.2k units) instead of a full open+close+reclaim (~60.7k). The one-time build/teardown amortizes over K = lifetime ÷ session window, so raising Channel lifetime drives the boundary cost toward just the rearm. This attacks the fixed toll that forces long windows — the capital-recycling plane of the decoupled architecture, not a per-payment saving.'}
                                </p>
                            </div>

                            <div className="knob-card">
                                <h3>Off-chain voucher plane</h3>
                                <RangeKnob
                                    disabled={!perPaymentVerify}
                                    format={value => `${formatCompact(value)} / s`}
                                    help="Aggregate Ed25519 verify rate — a horizontally scalable fleet, not a protocol limit (~50–100k/s/core batched; 10M/s ≈ a 100–200 core fleet)"
                                    label="Voucher verification rate"
                                    max={20_000_000}
                                    min={250_000}
                                    onChange={value => updateInput('voucherVerifyPerSecond', value)}
                                    step={250_000}
                                    value={inputs.voucherVerifyPerSecond}
                                />
                                <div className="batch-table">
                                    <div>
                                        <span>{perPaymentVerify ? 'Verification load' : 'Operator signing load'}</span>
                                        <strong>
                                            {formatCompact(perPaymentVerify ? logicalRequestsPerSecond : settlementsPerSecond, 2)} / second
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Verify budget used</span>
                                        <strong>{perPaymentVerify ? formatPercent(voucherVerifySharePercent) : 'n/a'}</strong>
                                    </div>
                                    <div>
                                        <span>Binding constraint</span>
                                        <strong>
                                            {bindingConstraint === 'none' ? 'neither (fits)' : bindingConstraint}
                                        </strong>
                                    </div>
                                </div>
                                <p className="batch-caveat">
                                    {perPaymentVerify
                                        ? 'One Ed25519 verification per incoming voucher, so hitting the target means sustaining that many voucher verifications/s off-chain — the report’s #1 remaining-work item. Unlike settlement batching or payments/channel this does not amortize, so at high on-chain amortization it becomes the real limiter; scale it by adding verifier cores.'
                                        : 'Operator-signed (mpp-specs #309): the operator signs cumulative vouchers, so there is no per-payment client Ed25519 to verify — this whole plane collapses from one verify per payment to one operator sign per settlement plus a cheap bearer-proof check per request. It stops being the limiter; the binding constraint reverts to the on-chain budget. The cost is trust: the client relies on the operator’s metering, bounded by the escrow deposit, instead of signing each increment itself.'}
                                </p>
                            </div>
                        </>
                    )}
                </div>
            </section>

            <section aria-label="Derived metrics" className="metrics-grid">
                <article className="metric-card">
                    <span>Cost units per block</span>
                    <strong>{formatCompact(inputs.blockCostUnits, 2)}</strong>
                    <small>scheduler limit</small>
                </article>
                <article className="metric-card">
                    <span>Blocks per second</span>
                    <strong>{blocksPerSecond.toFixed(2)}</strong>
                    <small>from {inputs.slotMs}ms slots</small>
                </article>
                <article className="metric-card">
                    <span>Nominal scheduler budget</span>
                    <strong>{formatCompact(nominalBudgetPerSecond, 2)}</strong>
                    <small>cost units / second</small>
                </article>
                <article className="metric-card">
                    <span>Available to this workload</span>
                    <strong>{formatCompact(availableBudgetPerSecond, 2)}</strong>
                    <small>{formatPercent(inputs.availableCapacityPercent)} of nominal</small>
                </article>
                <article className="metric-card">
                    <span>Physical chain transactions</span>
                    <strong>{formatCompact(physicalTransactionsPerSecond, 2)}</strong>
                    <small>transactions / second at selected demand</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'On-chain settlements' : 'Cost per payment'}</span>
                    <strong>
                        {isChannel ? formatCompact(settlementsPerSecond, 2) : formatInteger(inputs.transferCostUnits)}
                    </strong>
                    <small>{isChannel ? 'settlement boundaries / second (one per session)' : 'scheduler units'}</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'Concurrent live channels' : 'Required scheduler load'}</span>
                    <strong>
                        {isChannel ? formatCompact(liveChannels, 2) : formatCompact(requiredBudgetPerSecond, 2)}
                    </strong>
                    <small>{isChannel ? 'one active channel per payer' : 'cost units / second'}</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'Refundable rent capital' : 'Nominal capacity gap (100% budget)'}</span>
                    <strong>
                        {isChannel
                            ? `${formatCompact(rentWorkingCapital, 2)} SOL`
                            : `${(requiredBudgetPerSecond / nominalBudgetPerSecond).toFixed(2)}×`}
                    </strong>
                    <small>
                        {isChannel ? 'to keep payer channels live' : 'verdict uses the configured available percentage'}
                    </small>
                </article>
            </section>

            <section aria-labelledby="opex-title" className="panel controls-panel">
                <div className="section-heading">
                    <div>
                        <p className="section-index">04</p>
                        <h2 id="opex-title">Operating economics</h2>
                    </div>
                    <p>
                        Compare the network burn with vanilla transfers, then size the refundable capital needed to run
                        the rail. Separate from the CU capacity math above.
                    </p>
                </div>

                <div className="demand-controls opex-controls">
                    <RangeKnob
                        format={formatUsd}
                        help="Economic value carried by each request"
                        label="Avg transaction value"
                        max={1}
                        min={0.001}
                        onChange={value => updateDemand('averageTransactionValueUsd', value)}
                        step={0.001}
                        value={demand.averageTransactionValueUsd}
                    />
                    <RangeKnob
                        format={formatUsd}
                        help="SOL/USD used to price fees and capital"
                        label="SOL price"
                        max={500}
                        min={10}
                        onChange={value => updateDemand('solPriceUsd', value)}
                        step={5}
                        value={demand.solPriceUsd}
                    />
                    <RangeKnob
                        format={value => `${formatInteger(value)} lamports`}
                        help="Priority fee per tx (0 ≈ today's ~⅓-full blocks)"
                        label="Priority fee / tx"
                        max={100_000}
                        min={0}
                        onChange={value => updateDemand('priorityFeeLamportsPerTx', value)}
                        step={1_000}
                        value={demand.priorityFeeLamportsPerTx}
                    />
                    <RangeKnob
                        format={formatPercent}
                        help="Annual cost of the refundable capital held in the rail"
                        label="Cost of capital"
                        max={25}
                        min={0}
                        onChange={value => updateDemand('capitalCostAnnualPercent', value)}
                        step={0.5}
                        value={demand.capitalCostAnnualPercent}
                    />
                </div>

                <section aria-label="Network fee comparison" className="opex-summary">
                    <div className="opex-summary-heading">
                        <div>
                            <span>Network cost — actual burn</span>
                            <small>These fees leave the rail. They are not refundable.</small>
                        </div>
                        <strong>{formatUsd(grossValuePerSecondUsd * SECONDS_PER_DAY)} gross value / day</strong>
                    </div>
                    <div className="opex-comparison">
                        <article className="opex-rail opex-rail-selected">
                            <span>{MODE_LABELS[inputs.mode]}</span>
                            <strong>{formatUsd(networkFeeUsdPerSecond * SECONDS_PER_DAY)} / day</strong>
                            <small>{formatTakeRate(feeTakeRateBps)} network take-rate</small>
                        </article>
                        <div className="opex-versus" aria-label="Comparison result">
                            {inputs.mode === 'vanilla' ? (
                                <>
                                    <strong>Baseline</strong>
                                    <small>every payment settles on-chain</small>
                                </>
                            ) : (
                                <>
                                    <strong>{formatCompact(networkFeeMultiplier, 1)}× lower</strong>
                                    <small>{formatUsd(networkFeeSavingsUsdPerDay)} saved / day</small>
                                </>
                            )}
                        </div>
                        <article className="opex-rail">
                            <span>Vanilla transfers</span>
                            <strong>{formatUsd(vanillaNetworkFeeUsdPerSecond * SECONDS_PER_DAY)} / day</strong>
                            <small>{formatTakeRate(vanillaFeeTakeRateBps)} network take-rate</small>
                        </article>
                    </div>
                </section>

                <div className="opex-groups">
                    <section aria-label="Selected rail network costs" className="opex-group">
                        <div className="opex-group-heading">
                            <div>
                                <span>Selected rail</span>
                                <h3>Network fee breakdown</h3>
                            </div>
                            <p>Recurring costs that are paid to the network.</p>
                        </div>
                        <div className="opex-metrics-grid">
                            <article className="metric-card">
                                <span>Network fees</span>
                                <strong>{formatUsd(networkFeeUsdPerSecond * SECONDS_PER_DAY)}</strong>
                                <small>per day · {formatUsd(networkFeeUsdPerSecond * SECONDS_PER_MONTH)} / month</small>
                            </article>
                            <article className="metric-card">
                                <span>Fee take-rate</span>
                                <strong>{formatTakeRate(feeTakeRateBps)}</strong>
                                <small>network's cut of gross value</small>
                            </article>
                            <article className="metric-card">
                                <span>Annual network spend</span>
                                <strong>{formatUsd(feeUsdPerYear)}</strong>
                                <small>base and selected priority fees</small>
                            </article>
                        </div>
                    </section>

                    <section aria-label="Refundable capital requirements" className="opex-group opex-capital-group">
                        <div className="opex-group-heading">
                            <div>
                                <span>Capital required — refundable</span>
                                <h3>Working capital, not a fee</h3>
                            </div>
                            <p>These balances stay in the rail; only the annual carrying cost is an expense.</p>
                        </div>
                        <div className="opex-metrics-grid">
                            <article className="metric-card">
                                <span>Refundable rent capital</span>
                                <strong>{formatUsd(rentWorkingCapitalUsd)}</strong>
                                <small>
                                    {formatCompact(rentWorkingCapital, 2)} SOL across {formatCompact(liveChannels, 2)}{' '}
                                    channels
                                </small>
                            </article>
                            <article className="metric-card">
                                <span>Escrow float</span>
                                <strong>{formatUsd(escrowFloatUsd)}</strong>
                                <small>value in flight per settlement window</small>
                            </article>
                            <article className="metric-card">
                                <span>Capital carrying cost</span>
                                <strong>{formatUsd(capitalCarryingCostUsdPerYear)}</strong>
                                <small>per year on {formatUsd(workingCapitalUsd)} tied up</small>
                            </article>
                        </div>
                    </section>
                </div>

                <section aria-label="All-in annual operating cost" className="opex-total">
                    <div>
                        <span>All-in annual operating cost</span>
                        <small>Annual network spend plus the carrying cost of refundable capital.</small>
                    </div>
                    <strong>{formatUsd(totalOpexUsdPerYear)}</strong>
                    <span>{formatTakeRate(allInTakeRateBps)} of annual gross value</span>
                </section>
                <p className="opex-note">
                    Fees assume {signaturesPerTransaction} signature{signaturesPerTransaction === 1 ? '' : 's'}/tx at{' '}
                    {formatInteger(BASE_FEE_LAMPORTS_PER_SIGNATURE)} lamports each
                    {demand.priorityFeeLamportsPerTx > 0
                        ? ` + ${formatInteger(demand.priorityFeeLamportsPerTx)} lamports priority`
                        : ''}
                    , over {formatCompact(physicalTransactionsPerSecond, 2)} physical tx/s. Rent and escrow are refundable
                    capital, not a burn — only their carrying cost is a true operating expense.
                </p>
            </section>

            <div className="opex-sticky" aria-label="Operating economics — live summary">
                <div className="opex-sticky-rail">
                    <span className="opex-sticky-eyebrow">OpEx</span>
                    <span className="opex-sticky-label">{MODE_LABELS[inputs.mode]}</span>
                    <span className={`opex-sticky-verdict ${canHandleDemand ? 'pass' : 'over'}`}>
                        {canHandleDemand
                            ? 'fits 10M'
                            : `${formatCompact(logicalRequestsPerSecond / Math.max(sustainableCeiling, 1), 2)}× over`}
                    </span>
                </div>
                <div className="opex-sticky-metrics">
                    <div>
                        <span>Network fees</span>
                        <strong>{formatUsd(networkFeeUsdPerSecond * SECONDS_PER_DAY)}/day</strong>
                    </div>
                    <div>
                        <span>All-in opex</span>
                        <strong>{formatUsd(totalOpexUsdPerYear)}/yr</strong>
                    </div>
                    <div>
                        <span>All-in take-rate</span>
                        <strong>{formatTakeRate(allInTakeRateBps)}</strong>
                    </div>
                    {isChannel && (
                        <div>
                            <span>Escrow float</span>
                            <strong>{formatUsd(escrowFloatUsd)}</strong>
                        </div>
                    )}
                    <div>
                        <span>On-chain budget</span>
                        <strong>{formatPercent(budgetSharePercent)}</strong>
                    </div>
                </div>
            </div>

            <footer>
                <p>
                    Mainnet scheduler costs: SPL Token 1,911 · Token-2022 6,536 · channel v1 lifecycle 61,622. Channel
                    v2 remains an ADR-005 planning envelope until implemented and benchmarked.
                </p>
            </footer>
        </main>
    );
}
