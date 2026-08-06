// Standalone sweep mirroring App.tsx model math, to re-resolve preset shapes after
// (a) v2 is NOT available today  -> today = v1 + x402 (client-signed), no SIMDs;
// (b) cheapest must be swept to the true opex-minimum clock ("play with the clock").
const LAMPORTS_PER_SOL = 1e9;
const BASE_FEE = 5000;
const YEAR = 31_536_000;
const SPL = 1911;
const V1_LIFECYCLE = 61_622;
const STANDALONE_RECLAIM = 1_661;
const REARM = 19_000, TOPUP = 10_200, BOUNDARY_V2 = REARM + TOPUP; // 29200
const V2_OPEN = 36_086;
const V1_EX_OPEN = V1_LIFECYCLE - V2_OPEN; // 25536
const V2_CLOSE = 23_875;

const CLOCKS = [1,2,3,4,5,10,15,30,60,120,300,600,1800,3600,7200,10800,21600,43200,86400];
const CHECKPOINTS = CLOCKS; // same option set

function reclaim(b){return 617 + 1044/b;}
function checkpointCost(scheme,n){ n=Math.max(1,n); if(scheme==='x402')return 3166+1043/n; if(scheme==='mpp')return 890+3420/n; return 0; }
function lifecycleCost(mode,reclaimBatch,open,K){
  const r = reclaim(reclaimBatch);
  if(mode==='v1') return V1_EX_OPEN + open - STANDALONE_RECLAIM + r;
  const once = open + V2_CLOSE + r - BOUNDARY_V2;
  return BOUNDARY_V2 + once/Math.max(1,K);
}

function evalShape(cfg){
  const {users,rpm,clock,mode,scheme,checkpointClock,checkpointBatch,reclaimBatch,
    capacity,block,slotMs,open,voucherSigFeeRemoved,voucherVerify,
    channelLifetime,txnValue,solPrice,capitalPct,priority} = cfg;
  const bps = 1000/slotMs;
  const nominal = block*bps;
  const available = nominal*(capacity/100);
  const isChannel = mode!=='vanilla';
  const logicalRPS = users*rpm/60;
  const clockOn = clock>0;
  const requestsPerSettlement = isChannel ? (clockOn?Math.max(1,rpm*clock/60):1) : 1;
  const paymentsPerChannel = requestsPerSettlement;
  const channelLife = clockOn?clock:(rpm>0?60/rpm:Infinity);
  const K = clockOn?Math.max(1,channelLifetime/clock):1;
  const hasCk = isChannel && scheme!=='none';
  const ckEnabled = hasCk && checkpointClock>0;
  const ckChannels = isChannel?users:0;
  const ckCostPerCh = ckEnabled?checkpointCost(scheme,checkpointBatch):0;
  const ckPerSec = ckEnabled?ckChannels/checkpointClock:0;
  const ckCostPerSec = ckPerSec*ckCostPerCh;
  const ckTxPerSec = ckEnabled?ckPerSec/Math.max(1,checkpointBatch):0;
  const costPerLifecycle = isChannel?lifecycleCost(mode,reclaimBatch,open,K):SPL;
  const costPerPayment = isChannel?costPerLifecycle/paymentsPerChannel:SPL;
  const budgetForPayments = Math.max(0,available-ckCostPerSec);
  const maxPayments = costPerPayment>0?budgetForPayments/costPerPayment:0;
  const perPaymentVerify = mode!=='vanilla' && scheme!=='mpp';
  const verifyCeiling = perPaymentVerify?voucherVerify:Infinity;
  const sustainable = Math.min(maxPayments,verifyCeiling);
  const fits = logicalRPS<=sustainable;
  // opex
  const sessionsPerSec = isChannel?logicalRPS/paymentsPerChannel:0;
  const isV2 = mode==='v2';
  const buildsPerSec = isV2?sessionsPerSec/K:sessionsPerSec;
  const physTxPerSec = (!isChannel?logicalRPS
    : mode==='v1'? sessionsPerSec + sessionsPerSec + sessionsPerSec/reclaimBatch
    : sessionsPerSec*2 + buildsPerSec*(2+1/reclaimBatch)) + ckTxPerSec;
  const grossPerSec = logicalRPS*txnValue;
  const sigs = isChannel?(voucherSigFeeRemoved?1:2):1;
  const feeLamportsPerSec = physTxPerSec*(sigs*BASE_FEE+priority);
  const feeUsdPerSec = feeLamportsPerSec/LAMPORTS_PER_SOL*solPrice;
  const rentCapUsd = (isChannel?users:0)*cfg.rentPerChannelSol*solPrice;
  const windowSec = isChannel && isFinite(channelLife)?channelLife:1;
  const escrowFloatUsd = isChannel?grossPerSec*windowSec:0;
  const workingCapUsd = rentCapUsd+escrowFloatUsd;
  const carryPerYear = workingCapUsd*(capitalPct/100);
  const feePerYear = feeUsdPerSec*YEAR;
  const totalOpexPerYear = feePerYear+carryPerYear;
  const allInBps = grossPerSec>0?totalOpexPerYear/(grossPerSec*YEAR)*10000:0;
  // finality
  const required = logicalRPS*costPerPayment+ckCostPerSec;
  const backlog = available>0?required/available:Infinity;
  const enforceableFinality = ckEnabled?Math.min(checkpointClock,isFinite(channelLife)?channelLife:Infinity):channelLife;
  const settleLatency = isChannel?(isFinite(enforceableFinality)?enforceableFinality:0)*Math.max(1,backlog):Math.max(1,backlog)/Math.max(bps,0.001);
  const budgetShare = available>0?required/available*100:0;
  return {fits,maxPayments,sustainable,logicalRPS,costPerPayment,allInBps,totalOpexPerYear,
    settleLatency,budgetShare,physTxPerSec,escrowFloatUsd,carryPerYear,feePerYear,backlog,K,paymentsPerChannel,ckCostPerSec};
}

const HORIZON = {
  today:{mode:'v1',scheme:'x402',capacity:50,block:100_000_000,slotMs:400,open:36_086,voucherSigFeeRemoved:false,largeTx:false,checkpointBatch:5},
  longterm:{mode:'v2',scheme:'mpp',capacity:55,block:100_000_000,slotMs:400,open:17_300,voucherSigFeeRemoved:true,largeTx:true,checkpointBatch:59},
};
const base = {rpm:60,reclaimBatch:8,channelLifetime:604800,txnValue:0.05,solPrice:80,capitalPct:8,priority:0,rentPerChannelSol:0.00471192};

function cfgFor(scale,horizon,clock,checkpointClock){
  const h=HORIZON[horizon];
  const users = scale==='10M'?10_000_000:1_000_000;
  const voucherVerify = Math.min(20_000_000, users); // scaled Ed25519 fleet for x402-today
  return {...base,...h,users,clock,checkpointClock,voucherVerify};
}

function fittingClocks(scale,horizon,checkpointClock=0){
  return CLOCKS.filter(c=>evalShape(cfgFor(scale,horizon,c,checkpointClock)).fits);
}
// fastest checkpoint cadence that still fits, given a clock
function fastestCheckpoint(scale,horizon,clock){
  for(const cc of CHECKPOINTS){ if(evalShape(cfgFor(scale,horizon,clock,cc)).fits) return cc; }
  return 0;
}

for(const scale of ['1M','10M']){
  for(const horizon of ['today','longterm']){
    const fit = fittingClocks(scale,horizon,0);
    if(fit.length===0){ console.log(`\n### ${scale} | ${horizon}: NO fitting clock (no checkpoints)`); continue; }
    const shortest = fit[0];
    // opex-min clock (cheapest): sweep all fitting clocks, min totalOpex
    let cheapest=fit[0], cheapestOpex=Infinity, table=[];
    for(const c of fit){ const r=evalShape(cfgFor(scale,horizon,c,0)); table.push([c,r.totalOpexPerYear,r.allInBps,r.settleLatency,r.budgetShare]); if(r.totalOpexPerYear<cheapestOpex){cheapestOpex=r.totalOpexPerYear;cheapest=c;} }
    console.log(`\n### ${scale} | ${horizon}  (fitting clocks: ${fit.join(',')})`);
    console.log(`opex(clock): ${table.map(([c,o,b])=>`${c}s=$${(o/1e6).toFixed(1)}M/${b.toFixed(2)}bps`).join('  ')}`);
    // 00 shortest-window no checkpoint; 10 cheapest opex-min no checkpoint
    const r00=evalShape(cfgFor(scale,horizon,shortest,0));
    const r10=evalShape(cfgFor(scale,horizon,cheapest,0));
    // fastest: on the shortest window, add fastest checkpoint (01); both: on cheapest window, fastest checkpoint (11)
    const cc01=fastestCheckpoint(scale,horizon,shortest);
    const cc11=fastestCheckpoint(scale,horizon,cheapest);
    const r01=evalShape(cfgFor(scale,horizon,shortest,cc01));
    const r11=evalShape(cfgFor(scale,horizon,cheapest,cc11));
    const fmt=(label,clock,cc,r)=>`  ${label}: clock=${clock}s ck=${cc}s -> fit=${r.fits} finality=${r.settleLatency.toFixed(0)}s budget=${r.budgetShare.toFixed(0)}% allIn=${r.allInBps.toFixed(2)}bps opex=$${(r.totalOpexPerYear/1e6).toFixed(1)}M`;
    console.log(fmt('00 (neither) ',shortest,0,r00));
    console.log(fmt('10 (cheapest)',cheapest,0,r10));
    console.log(fmt('01 (fastest) ',shortest,cc01,r01));
    console.log(fmt('11 (both)    ',cheapest,cc11,r11));
  }
}
