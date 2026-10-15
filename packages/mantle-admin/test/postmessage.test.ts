import {expect,test,vi} from "vitest";
import {SUPPORTED_PROTOCOL_VERSIONS} from "@modelcontextprotocol/ext-apps/app-bridge";
import {applyHostContext,connectHost,type HostApi} from "../src/app/postmessage";

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
  send({jsonrpc:"2.0",id:initialize.id,result:{protocolVersion,hostInfo:{name:"test",version:"1"},hostCapabilities:{serverTools:{}},hostContext:{}}});
  await Promise.resolve(); await Promise.resolve();
  expect(ready).toHaveBeenCalledOnce();
  send({jsonrpc:"2.0",id:1,method:"ui/resource-teardown",params:{}},"https://other.test");
  expect(cancelled).not.toHaveBeenCalled();
  send({jsonrpc:"2.0",id:2,method:"ui/resource-teardown",params:{}});
  expect(postMessage).toHaveBeenLastCalledWith({jsonrpc:"2.0",id:2,result:{}},"https://host.test");
  expect(cancelled).toHaveBeenCalledOnce(); expect(removeEventListener).toHaveBeenCalled();
  await expect(ready.mock.calls[0]![0].call("write",{})).rejects.toThrow("Invalid tool call");
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

const handshake=async(hostCapabilities:Record<string,unknown>,hostContext:Record<string,unknown>={})=>{
 let receive: (event:MessageEvent)=>void=()=>{};
 const postMessage=vi.fn(),ready=vi.fn(),error=vi.fn(),context=vi.fn();
 const parent={postMessage};
 const win={parent,addEventListener:(_name:string,fn:typeof receive)=>{receive=fn;},removeEventListener:vi.fn(),requestAnimationFrame:()=>{},document:{documentElement:{},body:{}}} as unknown as Window;
 vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});
 const disconnect=connectHost({ready,input:vi.fn(),result:vi.fn(),cancelled:vi.fn(),context,error},win,"9.9.9");
 const send=(data:unknown)=>receive({source:parent,origin:"https://host.test",data} as unknown as MessageEvent);
 send({jsonrpc:"2.0",id:postMessage.mock.calls[0]![0].id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"test",version:"1"},hostCapabilities,hostContext}});
 await Promise.resolve(); await Promise.resolve();
 // answers the App's next request with `result`
 const answer=async<T>(pending:Promise<T>,result:unknown)=>{const id=postMessage.mock.lastCall![0].id;send({jsonrpc:"2.0",id,result});return pending;};
 return {postMessage,ready,error,context,send,answer,host:ready.mock.calls[0]?.[0] as HostApi|undefined,disconnect:()=>{disconnect();vi.unstubAllGlobals();}};
};

test("initialize names the package version and the display modes the App lays out for",async()=>{
 const {postMessage,disconnect}=await handshake({});
 expect(postMessage.mock.calls[0]![0].params).toEqual({appInfo:{name:"mantle",version:"9.9.9"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]},protocolVersion:"2026-01-26"});
 disconnect();
});

test("without serverTools the App gets no tool call, and requests the host did not advertise are never sent",async()=>{
 const {postMessage,host,disconnect}=await handshake({});
 expect(host!.call).toBeUndefined();
 const sent=postMessage.mock.calls.length;
 expect(await host!.openLink("https://example.com/")).toBe(false);
 expect(await host!.sendMessage("hi")).toBe(false);
 expect(await host!.updateModelContext({content:[{type:"text",text:"x"}]})).toBe(false);
 expect(await host!.requestDisplayMode("fullscreen")).toBeNull();
 expect(postMessage.mock.calls.length).toBe(sent);
 disconnect();
});

test("model context carries only the content kinds the host accepts",async()=>{
 const {postMessage,host,answer,disconnect}=await handshake({updateModelContext:{text:{}}});
 const sent=postMessage.mock.calls.length;
 expect(await host!.updateModelContext({structuredContent:{tool:"t"}})).toBe(false);
 expect(postMessage.mock.calls.length).toBe(sent);
 expect(await answer(host!.updateModelContext({content:[{type:"text",text:"done"}],structuredContent:{tool:"t"}}),{})).toBe(true);
 expect(postMessage.mock.lastCall![0].params).toEqual({content:[{type:"text",text:"done"}]});
 disconnect();
});

test("advertised host requests use the spec's methods; only http(s) links are opened",async()=>{
 const {postMessage,host,answer,send,disconnect}=await handshake({serverTools:{},openLinks:{},message:{text:{}},updateModelContext:{text:{},structuredContent:{}}},{availableDisplayModes:["inline"]});
 expect(typeof host!.call).toBe("function");
 const sent=postMessage.mock.calls.length;
 expect(await host!.openLink("javascript:alert(1)")).toBe(false);
 expect(await host!.openLink("/relative")).toBe(false);
 expect(postMessage.mock.calls.length).toBe(sent);
 expect(await answer(host!.openLink("https://example.com/a"),{})).toBe(true);
 expect(postMessage.mock.lastCall![0]).toMatchObject({method:"ui/open-link",params:{url:"https://example.com/a"}});
 expect(await answer(host!.openLink("https://example.com/b"),{isError:true})).toBe(false);
 expect(await answer(host!.sendMessage("hi"),{})).toBe(true);
 expect(postMessage.mock.lastCall![0]).toMatchObject({method:"ui/message",params:{role:"user",content:[{type:"text",text:"hi"}]}});
 expect(await answer(host!.updateModelContext({structuredContent:{tool:"t"}}),{})).toBe(true);
 expect(postMessage.mock.lastCall![0]).toMatchObject({method:"ui/update-model-context",params:{structuredContent:{tool:"t"}}});
 // fullscreen only once the host offers it
 expect(await host!.requestDisplayMode("fullscreen")).toBeNull();
 send({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{availableDisplayModes:["inline","fullscreen"]}});
 expect(await answer(host!.requestDisplayMode("fullscreen"),{mode:"fullscreen"})).toBe("fullscreen");
 expect(postMessage.mock.lastCall![0]).toMatchObject({method:"ui/request-display-mode",params:{mode:"fullscreen"}});
 disconnect();
});

test("host context the App applies is checked first: dimensions, insets, display modes, time zone",async()=>{
 const {context,send,disconnect}=await handshake({});
 for(const params of [{timeZone:"Not/AZone"},{displayMode:"theatre"},{availableDisplayModes:["inline","huge"]},{containerDimensions:{maxHeight:-1}},{containerDimensions:{width:Infinity}},{safeAreaInsets:{top:1,right:0,bottom:0}},{safeAreaInsets:{top:"1px",right:0,bottom:0,left:0}}])
  send({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params});
 expect(context).not.toHaveBeenCalled();
 send({jsonrpc:"2.0",method:"ui/notifications/host-context-changed",params:{timeZone:"Asia/Taipei",displayMode:"fullscreen",containerDimensions:{maxHeight:400,width:320},safeAreaInsets:{top:10,right:0,bottom:20,left:0}}});
 expect(context).toHaveBeenCalledOnce();
 disconnect();
});

test("applyHostContext: dark as both .dark and data-theme, only spec style variables, insets and the container's bounds",()=>{
 const properties=new Map<string,string>(),classes=new Set<string>();
 const style:Record<string,unknown>={setProperty:(key:string,value:string)=>properties.set(key,value)};
 const root={dataset:{} as Record<string,string>,style,classList:{toggle:(name:string,on:boolean)=>on?classes.add(name):classes.delete(name)}};
 const doc={documentElement:root} as unknown as Document;
 applyHostContext({theme:"dark",displayMode:"fullscreen",safeAreaInsets:{top:10,right:1,bottom:20,left:2},containerDimensions:{maxHeight:400,width:320},
  styles:{variables:{"--color-background-primary":"#000","--border-radius-md":"4px","--font-text-sm-size":"13px","--font-weight-medium":"550","--mantle-app-primary":"red","--color-primary":"red"} as never}},doc);
 expect(root.dataset).toEqual({theme:"dark",displayMode:"fullscreen"});
 expect([...classes]).toEqual(["dark"]);
 expect(Object.fromEntries(properties)).toEqual({"--color-background-primary":"#000","--border-radius-md":"4px","--font-text-sm-size":"13px","--font-weight-medium":"550"});
 expect(style).toMatchObject({padding:"10px 1px 20px 2px",maxHeight:"400px",width:"320px",height:"",maxWidth:"",overflow:"auto"});
 applyHostContext({theme:"light"},doc);
 expect([...classes]).toEqual([]);
});
