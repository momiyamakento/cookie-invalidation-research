import type { HeapInfo, HeapSpaceInfo } from 'node:v8';
export interface ProbeSnapshot { at:number; memory:NodeJS.MemoryUsage; heap:HeapInfo; spaces:HeapSpaceInfo[];cpu:NodeJS.CpuUsage;resources:string[]; }
export interface ProbeRead extends ProbeSnapshot {
 gc:Array<{start:number;duration:number;kind:number;flags:number}>;
 requests:Array<{start:number;headers:number|null;body:number|null;failed:boolean}>;
 incoming:Array<{start:number;finish:number|null}>;
 loop:{idle:number;active:number;utilization:number;maxMs:number;meanMs:number|null};
}
export function createProbe(): {snapshot():ProbeSnapshot;read(reset?:boolean):Promise<ProbeRead>;close():void};
