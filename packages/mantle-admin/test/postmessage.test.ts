import {expect,test,vi} from "vitest";
import {SUPPORTED_PROTOCOL_VERSIONS} from "@modelcontextprotocol/ext-apps/app-bridge";
import {connectHost} from "../src/app/postmessage";

test("official supported versions establish origin; teardown acknowledges and disconnects",async()=>{
 for(const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS){
  let receive: (event: MessageEvent)=>void = ()=>{};
  const postMessage=vi.fn(),removeEventListener=vi.fn(),cancelled=vi.fn(),ready=vi.fn();
  const parent={postMessage};
  const win={parent,addEventListener:(_name:string,fn:typeof receive)=>{receive=fn;},removeEventListener,requestAnimationFrame:()=>{},document:{documentElement:{},body:{}}} as unknown as Window;
  vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
  const disconnect=connectHost({ready,input:vi.fn(),result:vi.fn(),cancelled,context:vi.fn(),error:vi.fn()},win);
  const initialize=postMessage.mock.calls[0]![0];
  const send=(data:unknown,origin="https://host.test")=>receive({source:parent,origin,data} as unknown as MessageEvent);
  send({jsonrpc:"2.0",id:initialize.id,result:{protocolVersion,hostInfo:{name:"test",version:"1"},hostCapabilities:{},hostContext:{}}});
  await Promise.resolve(); await Promise.resolve();
  expect(ready).toHaveBeenCalledOnce();
  send({jsonrpc:"2.0",id:1,method:"ui/resource-teardown",params:{}},"https://other.test");
  expect(cancelled).not.toHaveBeenCalled();
  send({jsonrpc:"2.0",id:2,method:"ui/resource-teardown",params:{}});
  expect(postMessage).toHaveBeenLastCalledWith({jsonrpc:"2.0",id:2,result:{}},"https://host.test");
  expect(cancelled).toHaveBeenCalledOnce(); expect(removeEventListener).toHaveBeenCalled();
  await expect(ready.mock.calls[0]![0]("write",{})).rejects.toThrow("Invalid tool call");
  disconnect(); vi.unstubAllGlobals();
 }
});

test("unsupported host version cannot establish the bridge",async()=>{
 let receive: (event:MessageEvent)=>void=()=>{};
 const postMessage=vi.fn(),ready=vi.fn(),error=vi.fn();
 const parent={postMessage};
 const win={parent,addEventListener:(_name:string,fn:typeof receive)=>{receive=fn;},removeEventListener:vi.fn()} as unknown as Window;
 const disconnect=connectHost({ready,input:vi.fn(),result:vi.fn(),cancelled:vi.fn(),context:vi.fn(),error},win);
 const result={protocolVersion:"unsupported",hostInfo:{name:"test",version:"1"},hostCapabilities:{},hostContext:{}};
 receive({source:parent,origin:"https://host.test",data:{jsonrpc:"2.0",id:postMessage.mock.calls[0]![0].id,result}} as unknown as MessageEvent);
 await Promise.resolve(); await Promise.resolve();
 expect(ready).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
 disconnect();
});
