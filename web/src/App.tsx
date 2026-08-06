import { useId, useState } from 'react';

type ModelMode = 'vanilla' | 'channel-v1' | 'channel-v2';
type TransferKind = 'spl-token' | 'token-2022';

interface ModelInputs {
    availableCapacityPercent: number;
    blockCostUnits: number;
    mode: ModelMode;
    reclaimBatchSize: number;
    rentPerChannelSol: number;
    settlementBatchSize: number;
    slotMs: number;
    transferCostUnits: number;
    transferKind: TransferKind;
    voucherVerifyPerSecond: number;
}

interface DemandInputs {
    averageRequestsPerMinutePerUser: number;
    averageTransactionValueUsd: number;
    settlementClockSeconds: number;
    users: number;
}

type TimelineInputs = Pick<ModelInputs, 'availableCapacityPercent' | 'rentPerChannelSol' | 'slotMs'>;

interface Phase {
    readonly date: string;
    readonly description: string;
    readonly id: string;
    readonly inputs: TimelineInputs;
    readonly label: string;
    readonly status: 'Expected' | 'Live' | 'Target';
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
const SPL_TOKEN_TRANSFER_COST_UNITS = 1_911;
const TOKEN_2022_TRANSFER_COST_UNITS = 6_536;
const V1_LIFECYCLE_COST_UNITS = 61_622;
const STANDALONE_RECLAIM_COST_UNITS = 1_661;
const V2_NO_VOUCHER_LIFECYCLE_COST_UNITS = 54_325;
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

const DEFAULT_DEMAND: DemandInputs = {
    averageRequestsPerMinutePerUser: 60,
    averageTransactionValueUsd: 0.001,
    settlementClockSeconds: 60,
    users: 1_000_000,
};

const TODAY: ModelInputs = {
    availableCapacityPercent: 50,
    blockCostUnits: 100_000_000,
    mode: 'channel-v1',
    reclaimBatchSize: 8,
    rentPerChannelSol: 0.00471192,
    settlementBatchSize: 5,
    slotMs: 400,
    transferCostUnits: SPL_TOKEN_TRANSFER_COST_UNITS,
    transferKind: 'spl-token',
    voucherVerifyPerSecond: 1_000_000,
};

const PHASES: readonly Phase[] = [
    {
        date: 'Apr 2026',
        description: 'P-token cuts TransferChecked execution from 6,200 to 105 program CUs.',
        id: 'p-token',
        inputs: {
            availableCapacityPercent: 50,
            rentPerChannelSol: 0.00471192,
            slotMs: 400,
        },
        label: 'P-token',
        status: 'Live',
    },
    {
        date: 'Aug 5',
        description: 'Measured v1 lifecycle on 100M-unit blocks.',
        id: 'today',
        inputs: {
            availableCapacityPercent: 50,
            rentPerChannelSol: 0.00471192,
            slotMs: 400,
        },
        label: 'Today',
        status: 'Live',
    },
    {
        date: 'Q3 2026',
        description: 'Slots fall to 200ms; the block cost limit remains an independent scenario input.',
        id: '200ms-slots',
        inputs: {
            availableCapacityPercent: 50,
            rentPerChannelSol: 0.000471192,
            slotMs: 200,
        },
        label: '200ms slots',
        status: 'Target',
    },
];

const MODE_LABELS: Readonly<Record<ModelMode, string>> = {
    'channel-v1': 'Payment channel v1',
    'channel-v2': 'Payment channel v2',
    vanilla: 'Vanilla transfer',
};
const MODE_ORDER: readonly ModelMode[] = ['vanilla', 'channel-v1', 'channel-v2'];

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

function v1SettlementCostPerChannel(batchSize: number): number {
    return 3_166 + 1_043 / batchSize;
}

function v2SettlementCostPerChannel(batchSize: number): number {
    return 890 + 3_420 / batchSize;
}

function reclaimCostPerChannel(batchSize: number): number {
    return 617 + 1_044 / batchSize;
}

function lifecycleCost(inputs: ModelInputs): number {
    const reclaimCost = reclaimCostPerChannel(inputs.reclaimBatchSize);
    if (inputs.mode === 'channel-v1') {
        return V1_LIFECYCLE_COST_UNITS - STANDALONE_RECLAIM_COST_UNITS + reclaimCost;
    }

    return (
        V2_NO_VOUCHER_LIFECYCLE_COST_UNITS -
        STANDALONE_RECLAIM_COST_UNITS +
        reclaimCost +
        v2SettlementCostPerChannel(inputs.settlementBatchSize)
    );
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
export function App() {
    const [inputs, setInputs] = useState<ModelInputs>(TODAY);
    const [demand, setDemand] = useState<DemandInputs>(DEFAULT_DEMAND);
    const [selectedPhaseId, setSelectedPhaseId] = useState('today');
    const [isCustomized, setIsCustomized] = useState(false);

    const blocksPerSecond = 1_000 / inputs.slotMs;
    const nominalBudgetPerSecond = inputs.blockCostUnits * blocksPerSecond;
    const availableBudgetPerSecond = nominalBudgetPerSecond * (inputs.availableCapacityPercent / 100);
    const isChannel = inputs.mode !== 'vanilla';
    const logicalRequestsPerSecond = arrivingRequestsPerSecond(demand);
    const settlementClockEnabled = demand.settlementClockSeconds > 0;
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

    // Full happy-path lifecycle charged once per channel: open + settle_and_seal + distribute + reclaim.
    const costPerLifecycle = isChannel ? lifecycleCost(inputs) : inputs.transferCostUnits;
    // Session length = how long a channel accumulates vouchers before its single settle + close.
    const channelLifeSeconds = settlementClockEnabled
        ? demand.settlementClockSeconds
        : demand.averageRequestsPerMinutePerUser > 0
          ? 60 / demand.averageRequestsPerMinutePerUser
          : Infinity;

    // Amortized chain cost of a single logical payment: one lifecycle spread over the payments it carried.
    const costPerLogicalPayment = isChannel ? costPerLifecycle / paymentsPerChannel : inputs.transferCostUnits;

    const maximumPaymentsPerSecond = costPerLogicalPayment > 0 ? availableBudgetPerSecond / costPerLogicalPayment : 0;
    // Off-chain voucher plane: every logical payment is a voucher the session service must Ed25519-verify.
    // Vanilla transfers carry no vouchers, so only the on-chain ceiling applies there.
    const voucherVerifyCeiling = isChannel ? inputs.voucherVerifyPerSecond : Infinity;
    // A path sustains only as fast as its tightest stage: on-chain execution or off-chain verification.
    const sustainableCeiling = Math.min(maximumPaymentsPerSecond, voucherVerifyCeiling);
    const progressPercent = Math.min(100, (logicalRequestsPerSecond / TARGET_PAYMENTS_PER_SECOND) * 100);
    // Requests the selected path can actually sustain: demand capped by the tightest ceiling.
    const processedRequestsPerSecond = Math.min(logicalRequestsPerSecond, sustainableCeiling);
    const processedPercent = Math.min(100, (processedRequestsPerSecond / TARGET_PAYMENTS_PER_SECOND) * 100);
    const droppedRequestsPerSecond = Math.max(0, logicalRequestsPerSecond - processedRequestsPerSecond);
    const voucherVerifyBinds = isChannel && voucherVerifyCeiling < maximumPaymentsPerSecond;
    const bindingConstraint =
        droppedRequestsPerSecond <= 0
            ? 'none'
            : voucherVerifyBinds
              ? 'off-chain Ed25519 voucher verification'
              : 'on-chain execution budget';
    const requiredBudgetPerSecond = logicalRequestsPerSecond * costPerLogicalPayment;
    const budgetSharePercent =
        availableBudgetPerSecond > 0 ? (requiredBudgetPerSecond / availableBudgetPerSecond) * 100 : 0;
    const voucherVerifySharePercent = (logicalRequestsPerSecond / voucherVerifyCeiling) * 100;

    const channelLifecyclesPerSecond = isChannel ? logicalRequestsPerSecond / paymentsPerChannel : 0;
    // One on-chain settlement (settle_and_seal) per channel, at close.
    const settlementsPerSecond = channelLifecyclesPerSecond;
    // Each lifecycle lands an open, a terminal settle_and_seal+distribute, and a (batchable) reclaim.
    const physicalTransactionsPerSecond = isChannel
        ? channelLifecyclesPerSecond + // open, one channel / tx
          channelLifecyclesPerSecond + // terminal settle_and_seal + distribute, one channel / tx
          channelLifecyclesPerSecond / inputs.reclaimBatchSize // batched reclaim
        : logicalRequestsPerSecond;
    const liveChannels = isChannel ? demand.users : 0;
    const rentWorkingCapital = liveChannels * inputs.rentPerChannelSol;
    const grossValuePerSecondUsd = logicalRequestsPerSecond * demand.averageTransactionValueUsd;
    const valuePerSettlementUsd = requestsPerSettlement * demand.averageTransactionValueUsd;
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
    const selectedPhase = PHASES.find(phase => phase.id === selectedPhaseId) ?? PHASES[1];

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

    const selectPhase = (phase: Phase) => {
        setInputs(previous => ({ ...previous, ...phase.inputs }));
        setSelectedPhaseId(phase.id);
        setIsCustomized(false);
    };

    const selectMode = (mode: ModelMode) => {
        if (mode === inputs.mode) return;

        const settlementBatchSize = mode === 'channel-v1' ? Math.min(inputs.settlementBatchSize, 5) : 59;
        const transferCostUnits =
            inputs.transferKind === 'spl-token' ? SPL_TOKEN_TRANSFER_COST_UNITS : TOKEN_2022_TRANSFER_COST_UNITS;
        setInputs(previous => ({ ...previous, mode, settlementBatchSize, transferCostUnits }));
        setIsCustomized(true);
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
                    <p>Select a phase to load its assumptions.</p>
                </div>
                <div className="timeline">
                    {PHASES.map(phase => {
                        const isSelected = phase.id === selectedPhase.id;
                        return (
                            <button
                                aria-pressed={isSelected}
                                className={`phase ${isSelected ? 'phase-selected' : ''}`}
                                key={phase.id}
                                onClick={() => selectPhase(phase)}
                                type="button"
                            >
                                <span className="phase-date">{phase.date}</span>
                                <span className="phase-dot" />
                                <strong>{phase.label}</strong>
                                <small>{phase.status}</small>
                            </button>
                        );
                    })}
                </div>
                <div className="phase-summary" aria-live="polite">
                    <div>
                        <span>{isCustomized ? 'Custom scenario from' : 'Selected preset'}</span>
                        <strong>{selectedPhase.label}</strong>
                    </div>
                    <p>{selectedPhase.description}</p>
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
                        help="Concurrent users generating requests"
                        label="Users"
                        onChange={value => updateArrivingDemand('users', value)}
                        options={USER_STEPS}
                        value={demand.users}
                    />
                    <RangeKnob
                        format={value => `${formatInteger(value)} RPM`}
                        help="Average requests per minute per user"
                        label="Avg RPM/user"
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
                        onChange={value => updateDemand('settlementClockSeconds', value)}
                        options={SETTLEMENT_CLOCK_OPTIONS}
                        value={demand.settlementClockSeconds}
                    />
                    <RangeKnob
                        format={formatUsd}
                        help="Economic value only; excluded from CU math"
                        label="Avg transaction value"
                        max={1}
                        min={0.001}
                        onChange={value => updateDemand('averageTransactionValueUsd', value)}
                        step={0.001}
                        value={demand.averageTransactionValueUsd}
                    />
                </div>
                <div className="settlement-method-heading">
                    <strong>Settlement method</strong>
                    <span>Choose how logical requests reach the chain.</span>
                </div>
                <div aria-label="Settlement method" className="mode-switch progress-mode-switch" role="group">
                    {MODE_ORDER.map(mode => (
                        <button
                            aria-pressed={inputs.mode === mode}
                            className={inputs.mode === mode ? 'active' : ''}
                            key={mode}
                            onClick={() => selectMode(mode)}
                            type="button"
                        >
                            <span>{MODE_LABELS[mode]}</span>
                            <small>
                                {mode === 'vanilla'
                                    ? 'one on-chain tx / payment'
                                    : mode === 'channel-v1'
                                      ? 'single-channel vouchers'
                                      : 'ADR-004 batch vouchers'}
                            </small>
                        </button>
                    ))}
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
                        {formatCompact(demand.users, 2)} users × {formatInteger(demand.averageRequestsPerMinutePerUser)}{' '}
                        RPM ÷ 60 = {formatCompact(logicalRequestsPerSecond, 2)} req/s
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
                {isChannel && (
                    <div className="capacity-equation">
                        <span>Voucher plane</span>
                        <strong>{formatCompact(voucherVerifyCeiling, 2)} Ed25519 verifications/s</strong>
                        <small>
                            Each logical payment is one voucher the session service verifies off-chain. This caps
                            sustained requests independently of the on-chain budget, and does not move with settlement
                            batching or payments/channel — so with heavy on-chain amortization it becomes the binding
                            limit. Sustained throughput = {formatCompact(sustainableCeiling, 2)} req/s (min of the two
                            ceilings).
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
                        {isChannel
                            ? `; off-chain uses ${formatPercent(voucherVerifySharePercent)} of the ${formatCompact(voucherVerifyCeiling, 2)} vouchers/s Ed25519 budget`
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
                                        <span>Channel life (session)</span>
                                        <strong>
                                            {Number.isFinite(channelLifeSeconds)
                                                ? `${formatCompact(channelLifeSeconds, 2)} s`
                                                : '∞'}
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Channel opens+closes</span>
                                        <strong>{formatCompact(channelLifecyclesPerSecond, 2)} / second</strong>
                                    </div>
                                    <div>
                                        <span>Settlement rate</span>
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
                                    format={value => `${value} channels / tx`}
                                    help={
                                        inputs.mode === 'channel-v1'
                                            ? 'Repeated [Ed25519, settle] pairs; packet-bound'
                                            : 'One ADR-004 commitment; account-bound'
                                    }
                                    label="Settlement batch"
                                    max={inputs.mode === 'channel-v1' ? 5 : 59}
                                    min={1}
                                    onChange={value => updateInput('settlementBatchSize', value)}
                                    step={1}
                                    value={inputs.settlementBatchSize}
                                />
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
                                <div className="batch-table">
                                    <div>
                                        <span>Open</span>
                                        <strong>1 channel / tx</strong>
                                    </div>
                                    <div>
                                        <span>Terminal distribute</span>
                                        <strong>1 channel / tx</strong>
                                    </div>
                                    <div>
                                        <span>Settlement cost</span>
                                        <strong>
                                            {formatInteger(
                                                inputs.mode === 'channel-v1'
                                                    ? v1SettlementCostPerChannel(inputs.settlementBatchSize)
                                                    : v2SettlementCostPerChannel(inputs.settlementBatchSize),
                                            )}{' '}
                                            units / channel
                                        </strong>
                                    </div>
                                    <div>
                                        <span>Lifecycle cost</span>
                                        <strong>{formatInteger(costPerLifecycle)} units / channel</strong>
                                    </div>
                                </div>
                                <p className="batch-caveat">
                                    {inputs.mode === 'channel-v1'
                                        ? 'One channel = one session: open, a single settle_and_seal + distribute at idle-close, and a batched reclaim. Payments/channel is derived from the session window × request rate (capped by escrow deposit ÷ payment value), so longer sessions amortize the fixed open+distribute over more payments. Lengthen the session clock until the verdict fits the target — the crossover scales linearly with it.'
                                        : 'ADR-004 batches many channels’ settles into one transaction — proposed, not benchmarked. It shrinks the per-channel settle, but open and terminal distribute still dominate the lifecycle.'}
                                </p>
                            </div>

                            <div className="knob-card">
                                <h3>Off-chain voucher plane</h3>
                                <RangeKnob
                                    format={value => `${formatCompact(value)} / s`}
                                    help="Ed25519 voucher verifications the session service sustains"
                                    label="Voucher verification rate"
                                    max={2_000_000}
                                    min={250_000}
                                    onChange={value => updateInput('voucherVerifyPerSecond', value)}
                                    step={50_000}
                                    value={inputs.voucherVerifyPerSecond}
                                />
                                <div className="batch-table">
                                    <div>
                                        <span>Verification load</span>
                                        <strong>{formatCompact(logicalRequestsPerSecond, 2)} / second</strong>
                                    </div>
                                    <div>
                                        <span>Verify budget used</span>
                                        <strong>{formatPercent(voucherVerifySharePercent)}</strong>
                                    </div>
                                    <div>
                                        <span>Binding constraint</span>
                                        <strong>
                                            {bindingConstraint === 'none' ? 'neither (fits)' : bindingConstraint}
                                        </strong>
                                    </div>
                                </div>
                                <p className="batch-caveat">
                                    One Ed25519 verification per incoming voucher. The report&rsquo;s top remaining-work
                                    item is sustaining &ge;10M voucher updates/s off-chain — this knob is that ceiling,
                                    and unlike settlement batching or payments/channel it does not amortize, so it is
                                    often the real limiter at high amortization.
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
                    <small>{isChannel ? 'intermediate + terminal settles / second' : 'scheduler units'}</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'Concurrent live channels' : 'Required scheduler load'}</span>
                    <strong>
                        {isChannel ? formatCompact(liveChannels, 2) : formatCompact(requiredBudgetPerSecond, 2)}
                    </strong>
                    <small>{isChannel ? 'one active channel per user' : 'cost units / second'}</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'Refundable rent capital' : 'Nominal capacity gap (100% budget)'}</span>
                    <strong>
                        {isChannel
                            ? `${formatCompact(rentWorkingCapital, 2)} SOL`
                            : `${(requiredBudgetPerSecond / nominalBudgetPerSecond).toFixed(2)}×`}
                    </strong>
                    <small>
                        {isChannel ? 'to keep user channels live' : 'verdict uses the configured available percentage'}
                    </small>
                </article>
                <article className="metric-card">
                    <span>Gross transaction value</span>
                    <strong>{formatUsd(grossValuePerSecondUsd)}</strong>
                    <small>per second; excluded from CU math</small>
                </article>
                <article className="metric-card">
                    <span>{isChannel ? 'Value per settlement' : 'Average transaction value'}</span>
                    <strong>{formatUsd(isChannel ? valuePerSettlementUsd : demand.averageTransactionValueUsd)}</strong>
                    <small>
                        {isChannel ? `${formatCompact(requestsPerSettlement, 2)} requests amortized` : 'per transfer'}
                    </small>
                </article>
            </section>

            <footer>
                <p>
                    Mainnet scheduler costs: SPL Token 1,911 · Token-2022 6,536 · channel v1 lifecycle 61,622. Channel
                    v2 remains an ADR-004 planning envelope until implemented and benchmarked.
                </p>
            </footer>
        </main>
    );
}
