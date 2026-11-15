import {useTranslation} from 'react-i18next';
import type {ContentTextOutcome} from '../../pdf/export/contentText/outcomes';
export function ContentTextOutcomes({outcomes=[]}:{outcomes?:readonly ContentTextOutcome[]}) {
 const{t}=useTranslation();if(!outcomes.length)return null;
 const counts=new Map<string,number>();
 for(const o of outcomes){const label=o.reason?t(`contentText.reasons.${o.reason}`):t(`contentText.modes.${o.mode}`);counts.set(label,(counts.get(label)??0)+1);}
 return <div role="status" style={{fontSize:12,marginTop:8}}>{[...counts].map(([label,count])=><div key={label}>{label}: {count}</div>)}</div>;
}
