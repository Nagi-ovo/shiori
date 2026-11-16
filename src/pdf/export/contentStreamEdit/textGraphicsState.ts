/** Graphics/text parameters inherited by a Form invocation. Matrices inside
 * BT are reset by BT; only the CTM and these parameters cross a Do. */
export type TextGraphicsState = {
 ctm:[number,number,number,number,number,number];
 charSpacing:number;wordSpacing:number;horizontalScale:number;leading:number;
 rise:number;renderMode:number;fontName:string|null;fontSize:number;
 fontTainted:boolean;
};
