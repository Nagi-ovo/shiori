import {rejectType1} from './type1Support';

/** Built-in Adobe Type1 semantics only (T1_SPEC §§8.1, 8.3–8.4).
 * Font-supplied PostScript procedures are never evaluated. Both stacks and
 * flex state belong to one glyph closure and survive calls to ordinary Subrs. */
export function type1OtherSubrs(name:string) {
  const ps:number[]=[];
  let source=0,flex:{points:readonly number[][];moved:boolean}|undefined,setPoint=false;
  const fail=(operator:string,detail:string):never=>rejectType1('type1-other-subr-unsupported',`${name}: ${operator}: ${detail}`);
  return {
    before(op:number|'number') {
      if(ps.length&&op!==1217)fail('pop',`OtherSubr ${source} results must be popped immediately`);
      if(setPoint&&!ps.length&&op!==1233)fail('OtherSubr 0','pop pop must be followed by setcurrentpoint');
      if(flex&&op!=='number'&&![4,21,22,10,11,1212,1216].includes(op))fail('OtherSubr 1',`operator ${op} during flex`);
    },
    call(stack:number[],point:readonly number[]) {
      if(stack.length<2)fail('callothersubr',`missing count/index (${stack.at(-1)??'empty'})`);
      const index=stack.pop()!,count=stack.pop()!,operator=`OtherSubr ${index}`;
      if(!Number.isInteger(index)||index<0||index>3)fail(operator,'unsupported index');
      const expected=[3,0,0,1][index]!;
      if(count!==expected||stack.length<count)fail(operator,`arity ${count}, expected ${expected} available arguments`);
      const args=stack.splice(stack.length-count,count);source=index;
      if(index===1){
        if(flex)fail(operator,'nested flex start');
        flex={points:[],moved:false};
      }else if(index===2){
        if(!flex||!flex.moved)fail(operator,'flex vector without start/move');
        if(flex!.points.length>=7)fail(operator,'more than seven flex vectors');
        flex!.points=[...flex!.points,[...point]];flex!.moved=false;
      }else if(index===0){
        if(!flex||flex.points.length!==7||flex.moved)fail(operator,'end flex requires start and seven recorded vectors');
        if(Math.abs(args[1]!-point[0]!)>1e-7||Math.abs(args[2]!-point[1]!)>1e-7)fail(operator,'end flex coordinates disagree');
        // PS stack is bottom-to-top: the next two pops yield x then y.
        ps.push(args[2]!,args[1]!);flex=undefined;setPoint=true;
      }else {
        if(flex)fail(operator,'hint replacement during flex');
        if(!Number.isInteger(args[0])||args[0]!<0)fail(operator,'hint replacement requires a Subr index');
        ps.push(args[0]!);
      }
    },
    pop() {if(!ps.length)return fail('pop','empty PostScript result stack');return ps.pop()!;},
    move() {if(flex){if(flex.moved)fail('OtherSubr 2','unrecorded flex vector');flex.moved=true;}},
    setCurrentPoint() {setPoint=false;},
  };
}
