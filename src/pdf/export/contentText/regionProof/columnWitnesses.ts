import type {ParagraphLine,TextTrace,VisualGroup} from './types';
import {lineStart,paragraphMember} from './geometry';
import {visualLineEnd} from './visualGroups';

export type ColumnWitness={group:VisualGroup;line:ParagraphLine;left:number;end:number;y:number};
export const columnLines=(groups:readonly VisualGroup[],ends:ReadonlyMap<number,TextTrace>):ColumnWitness[]=>
 groups.flatMap(group=>group.lines.map(line=>({group,line,left:lineStart(line,true)[0],end:visualLineEnd(line,ends),y:lineStart(line,true)[1]})));
/** Paragraph membership allows face changes. Borrowed leading/measure must
 * additionally use the exact source font object, not a face-name guess. */
export const sameColumnStyle=(w:ColumnWitness,style:TextTrace)=>!w.group.refusal&&w.line.shows.every(s=>
 [s.before,s.after].every(t=>t.fontObject===style.fontObject&&paragraphMember(t,style)));
export const nonblankWitness=(w:ColumnWitness)=>w.line.shows.some(s=>s.unicode.trim().length>0);
