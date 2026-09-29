import { useEffect, useState } from "react";

export function IterationLimitEditor({ label, limit, busy, onSave }: {
  label: string; limit: number | null; busy: boolean; onSave: (limit: number | null) => void;
}) {
  const [unlimited, setUnlimited] = useState(limit === null), [value, setValue] = useState(String(limit ?? 3));
  useEffect(() => { setUnlimited(limit === null); setValue(String(limit ?? 3)); }, [limit]);
  return <details><summary>{label} 한도 설정</summary><form onSubmit={e => { e.preventDefault(); onSave(unlimited ? null : Number(value)); }}>
    <label>{label} 한도 <select aria-label={`${label} 한도`} value={unlimited ? "unlimited" : "limited"} disabled={busy}
      onChange={e => setUnlimited(e.target.value === "unlimited")}><option value="unlimited">제한 없음</option><option value="limited">횟수 지정</option></select></label>
    {!unlimited && <input aria-label={`${label} 최대 횟수`} type="number" min="0" step="1" value={value} required disabled={busy} onChange={e => setValue(e.target.value)} />}
    <button disabled={busy || (!unlimited && (!Number.isSafeInteger(Number(value)) || Number(value) < 0))}>한도 저장</button>
  </form></details>;
}
