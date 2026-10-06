export function nextRealtimeVideoDue({now,previousDue,durationMs,fps=30}={}){
  const current=Number(now);
  const prior=Number(previousDue);
  const fallback=1000/Math.max(1,Number(fps)||30);
  const duration=Number.isFinite(Number(durationMs))&&Number(durationMs)>0?Number(durationMs):fallback;
  const base=Number.isFinite(prior)&&prior>current?prior:current;
  return base+duration;
}
