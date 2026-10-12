import { AsyncLocalStorage } from "node:async_hooks";
import { ContractError } from "../contracts.js";

export const context = new AsyncLocalStorage<{ outer?: object; handle?: object; changes?: Map<string, number>; parents?: Map<string, number> }>();
export function guard(db: object): void {
  if (context.getStore()?.outer === db) throw new ContractError("INPUT_VALIDATION_FAILED", "Inside store.transaction use tx, not the outer store or handle.", "store/transaction");
}

/** One atomic write cannot publish a translation and change its parent's status. */
export function translationWrite(db:object,schema:string,parent?:string):()=>void {
 const state=context.getStore();if(!state||state.handle!==db)return ()=>{};
 schema=schema.toLowerCase();parent=parent?.toLowerCase();
 if(state.parents?.has(schema)||parent&&state.changes?.has(parent))throw new ContractError("INPUT_VALIDATION_FAILED","Publish the translation and change its parent status in separate writes.","translations");
 const changes=state.changes??=new Map(),parents=state.parents??=new Map();
 changes.set(schema,(changes.get(schema)??0)+1);if(parent)parents.set(parent,(parents.get(parent)??0)+1);
 return ()=>{for(const [map,key] of [[changes,schema],[parents,parent]] as const)if(key){const count=map.get(key)!-1;if(count)map.set(key,count);else map.delete(key);}};
}
