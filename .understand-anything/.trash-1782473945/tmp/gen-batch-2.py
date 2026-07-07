import json

with open('/Users/aotter/projects/aotter-clam-mantle-workroot/mantle/.understand-anything/tmp/batch-input-2.json') as f:
    bid = json.load(f)
imports = bid['batchImportData']

nodes = []
edges = []

def fnode(path, name, summary, tags, complexity, notes=None):
    n = {"id": f"file:{path}", "type": "file", "name": name, "filePath": path,
         "summary": summary, "tags": tags, "complexity": complexity}
    if notes: n["languageNotes"] = notes
    nodes.append(n)

def cnode(path, cls, summary, tags, complexity, rng):
    nodes.append({"id": f"class:{path}:{cls}", "type": "class", "name": cls, "filePath": path,
                  "lineRange": rng, "summary": summary, "tags": tags, "complexity": complexity})

def funcnode(path, fn, summary, tags, complexity, rng):
    nodes.append({"id": f"function:{path}:{fn}", "type": "function", "name": fn, "filePath": path,
                  "lineRange": rng, "summary": summary, "tags": tags, "complexity": complexity})

def edge(s, t, ty, w):
    edges.append({"source": s, "target": t, "type": ty, "direction": "forward", "weight": w})

# import edges for every file (1:1)
for path, deps in imports.items():
    for dep in deps:
        edge(f"file:{path}", f"file:{dep}", "imports", 0.7)

# ---------- file nodes + sub-nodes ----------
P = "packages/mantle-runtime/src/usecase/"
T = "packages/mantle-runtime/test/"

# ListEntriesUseCase
p = P+"content/ListEntriesUseCase.ts"
fnode(p, "ListEntriesUseCase.ts", "分頁列出某 collection entry 的 usecase，校驗 schema 存在後委派 EntryRepository.list 並 clamp 分頁參數。", ["usecase","content","pagination","data-model"], "simple")
cnode(p, "ListEntriesUseCase", "列出 entry 的應用服務；execute/executePage 在查詢前驗證 schema 名稱，未知時回傳 schemaUnknown diagnostic。", ["usecase","content","pagination"], "moderate", [41,71])
edge(f"file:{p}", f"class:{p}:ListEntriesUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:ListEntriesUseCase", "exports", 0.8)
edge(f"class:{p}:ListEntriesUseCase", f"file:{P}content/diagnostics.ts", "calls", 0.8)
edge(f"class:{p}:ListEntriesUseCase", f"file:packages/mantle-runtime/src/domain/service/Pagination.ts", "calls", 0.8)

# RequestPublishUseCase
p = P+"content/RequestPublishUseCase.ts"
fnode(p, "RequestPublishUseCase.ts", "請求發佈 entry 的 usecase；檢查狀態轉移合法性、translates 父層已發佈不變式，並透過 publishCache 進行 KV 快取失效。", ["usecase","content","publish","validation"], "moderate")
cnode(p, "RequestPublishUseCase", "發佈請求應用服務；驗證審核需求、狀態轉移與翻譯父層發佈狀態後，透過 EntryRepository.transitionStatus 寫入並觸發快取效應。", ["usecase","content","publish","validation"], "complex", [37,124])
funcnode(p, "missingTranslatesParentDiagnostic", "建構翻譯父層 entry 缺失或未發佈時的 runtime diagnostic，內含 JSON 化的脈絡資訊。", ["diagnostic","validation","i18n"], "simple", [126,147])
edge(f"file:{p}", f"class:{p}:RequestPublishUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:RequestPublishUseCase", "exports", 0.8)
edge(f"file:{p}", f"function:{p}:missingTranslatesParentDiagnostic", "contains", 1.0)
edge(f"class:{p}:RequestPublishUseCase", f"file:{P}content/diagnostics.ts", "calls", 0.8)
edge(f"class:{p}:RequestPublishUseCase", f"file:{P}content/ContentPublishEffects.ts", "calls", 0.8)
edge(f"class:{p}:RequestPublishUseCase", f"file:packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts", "calls", 0.8)

# UnpublishUseCase
p = P+"content/UnpublishUseCase.ts"
fnode(p, "UnpublishUseCase.ts", "下架已發佈 entry 的 usecase；校驗狀態轉移合法性後轉回 draft，並透過 unpublishCache 失效 KV 快取。", ["usecase","content","publish"], "simple")
cnode(p, "UnpublishUseCase", "下架應用服務；execute 驗證 entry 存在與狀態轉移合法，呼叫 transitionStatus 並觸發 unpublishCache 效應。", ["usecase","content","publish"], "moderate", [24,62])
edge(f"file:{p}", f"class:{p}:UnpublishUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:UnpublishUseCase", "exports", 0.8)
edge(f"class:{p}:UnpublishUseCase", f"file:{P}content/diagnostics.ts", "calls", 0.8)
edge(f"class:{p}:UnpublishUseCase", f"file:{P}content/ContentPublishEffects.ts", "calls", 0.8)

# UpdateDraftUseCase
p = P+"content/UpdateDraftUseCase.ts"
fnode(p, "UpdateDraftUseCase.ts", "更新草稿 entry 的 usecase；透過 BuiltinProjector 投影並蓋章資料、經 EntryWriteGuard 把關後以樂觀鎖更新。", ["usecase","content","validation"], "moderate")
cnode(p, "UpdateDraftUseCase", "草稿更新應用服務；execute 驗證 schema、投影更新資料並經 write guard 把關後寫入 EntryRepository。", ["usecase","content","validation"], "moderate", [24,93])
funcnode(p, "authoringContext", "由 HandlerContext 與 authorId 組出投影所需的 authoring context 物件。", ["utility","content"], "simple", [95,102])
edge(f"file:{p}", f"class:{p}:UpdateDraftUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:UpdateDraftUseCase", "exports", 0.8)
edge(f"file:{p}", f"function:{p}:authoringContext", "contains", 1.0)
edge(f"class:{p}:UpdateDraftUseCase", f"file:{P}content/diagnostics.ts", "calls", 0.8)
edge(f"class:{p}:UpdateDraftUseCase", f"file:packages/mantle-runtime/src/domain/service/BuiltinProjector.ts", "calls", 0.8)
edge(f"class:{p}:UpdateDraftUseCase", f"file:packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts", "calls", 0.8)

# diagnostics.ts
p = P+"content/diagnostics.ts"
fnode(p, "diagnostics.ts", "content usecase 共用的 diagnostic 工廠集合（衝突、找不到、非法轉移、未知 schema）與保留欄位處理工具。", ["utility","diagnostic","content","validation"], "moderate")
funcnode(p, "withConflictDiagnostic", "包裝寫入操作，將版本/狀態衝突例外轉譯為結構化 runtime diagnostic。", ["utility","diagnostic","error-handling"], "moderate", [19,52])
funcnode(p, "stripReservedDataKeys", "從 entry data 物件移除 runtime 保留欄位，避免作者覆寫系統欄位。", ["utility","validation","serialization"], "simple", [121,132])
for fn,rng in [("notFoundDiagnostic",[54,67]),("illegalTransitionDiagnostic",[69,82]),("schemaUnknownDiagnostic",[84,98])]:
    funcnode(p, fn, f"建構 {fn} 結構化 runtime diagnostic 供 content usecase 回報錯誤。", ["utility","diagnostic"], "simple", rng)
for fn in ["withConflictDiagnostic","notFoundDiagnostic","illegalTransitionDiagnostic","schemaUnknownDiagnostic","stripReservedDataKeys"]:
    edge(f"file:{p}", f"function:{p}:{fn}", "contains", 1.0)
    edge(f"file:{p}", f"function:{p}:{fn}", "exports", 0.8)

# content/index.ts (barrel)
p = P+"content/index.ts"
fnode(p, "index.ts", "content usecase 的 barrel，匯出各內容操作 usecase 與共用 diagnostic 工廠。", ["barrel","entry-point","content"], "simple")

# dto/content/index.ts
p = P+"dto/content/index.ts"
fnode(p, "index.ts", "content usecase 的請求/回應 DTO 與 ContentState enum 定義，承載各內容操作的型別契約。", ["type-definition","data-model","content"], "moderate")

# dto/lifecycle/index.ts
p = P+"dto/lifecycle/index.ts"
fnode(p, "index.ts", "lifecycle usecase 的 DTO 定義，描述 deferred hook 執行請求的型別。", ["type-definition","lifecycle"], "simple")

# dto/procedure/index.ts
p = P+"dto/procedure/index.ts"
fnode(p, "index.ts", "procedure usecase 的請求/回應 DTO 定義，承載 procedure 呼叫的型別契約。", ["type-definition","procedure"], "simple")

# RunDeferredHookUseCase
p = P+"lifecycle/RunDeferredHookUseCase.ts"
fnode(p, "RunDeferredHookUseCase.ts", "執行 deferred lifecycle hook 的 usecase，將 hook envelope 委派給 LifecycleHookRunner。", ["usecase","lifecycle","event-handler"], "simple")
cnode(p, "RunDeferredHookUseCase", "延遲 hook 執行應用服務；execute 解包 envelope 並委派 LifecycleHookRunner.run。", ["usecase","lifecycle","event-handler"], "simple", [23,46])
edge(f"file:{p}", f"class:{p}:RunDeferredHookUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:RunDeferredHookUseCase", "exports", 0.8)

# RunLifecycleHooksUseCase
p = P+"lifecycle/RunLifecycleHooksUseCase.ts"
fnode(p, "RunLifecycleHooksUseCase.ts", "依 TriggerIndex 查出對應某 lifecycle hook 的 procedure 並逐一觸發呼叫的 usecase。", ["usecase","lifecycle","event-handler"], "moderate")
cnode(p, "RunLifecycleHooksUseCase", "lifecycle hook 派發應用服務；run/runOne 由 TriggerIndex 解析觸發的 procedure 並透過注入的 invoke fn 執行。", ["usecase","lifecycle","event-handler","dispatcher"], "complex", [46,118])
edge(f"file:{p}", f"class:{p}:RunLifecycleHooksUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:RunLifecycleHooksUseCase", "exports", 0.8)
edge(f"class:{p}:RunLifecycleHooksUseCase", f"file:packages/mantle-runtime/src/domain/service/TriggerIndex.ts", "calls", 0.8)

# lifecycle/index.ts
p = P+"lifecycle/index.ts"
fnode(p, "index.ts", "lifecycle usecase 的 barrel，匯出 RunLifecycleHooksUseCase 與 RunDeferredHookUseCase。", ["barrel","entry-point","lifecycle"], "simple")

# media/index.ts
p = P+"media/index.ts"
fnode(p, "index.ts", "media usecase 的 barrel，匯出建立/提交上傳 usecase 及 MIME 白名單與上傳常數。", ["barrel","entry-point","media"], "simple")

# InvokeBuiltinUseCase
p = P+"procedure/InvokeBuiltinUseCase.ts"
fnode(p, "InvokeBuiltinUseCase.ts", "執行內建 CRUD 操作（create/update/upsert/delete/archive）的 usecase，將 builtin procedure 投影並寫入 EntryRepository。", ["usecase","procedure","data-model","crud"], "complex", "以 op 方法分派各內建操作，搭配 BuiltinProjector 與 EntryWriteGuard 維持寫入不變式。")
cnode(p, "InvokeBuiltinUseCase", "內建操作應用服務；run 依 op 名分派至 opCreate/opUpdate/opUpsert/opDelete/opArchive，投影資料並把關後寫入。", ["usecase","procedure","crud","data-model"], "complex", [39,236])
funcnode(p, "requireField", "從 builtin 輸入中取出並驗證指定欄位型別，缺失或型別錯誤時拋出 runtime diagnostic。", ["utility","validation"], "moderate", [238,258])
edge(f"file:{p}", f"class:{p}:InvokeBuiltinUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:InvokeBuiltinUseCase", "exports", 0.8)
edge(f"file:{p}", f"function:{p}:requireField", "contains", 1.0)
edge(f"class:{p}:InvokeBuiltinUseCase", f"file:packages/mantle-runtime/src/domain/service/BuiltinProjector.ts", "calls", 0.8)
edge(f"class:{p}:InvokeBuiltinUseCase", f"file:packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts", "calls", 0.8)

# InvokeProcedureUseCase
p = P+"procedure/InvokeProcedureUseCase.ts"
fnode(p, "InvokeProcedureUseCase.ts", "procedure 呼叫的核心 usecase：評估 auth 述詞、以 zod 驗證輸入/輸出（含快取）、委派 handler 或內建操作。", ["usecase","procedure","validation","dispatcher"], "complex", "以 inputCache/outputCache 快取 JSON-Schema→zod 編譯結果，避免每次呼叫重編譯。")
cnode(p, "InvokeProcedureUseCase", "procedure 派發應用服務；execute 做 auth 評估、輸入輸出 zod 驗證並委派 handler/builtin，含 validator 編譯快取。", ["usecase","procedure","validation","dispatcher"], "complex", [55,212])
cnode(p, "InvokeFailure", "代表 procedure 呼叫失敗並攜帶結構化 diagnostic 的錯誤類別。", ["error-handling","procedure"], "simple", [48,53])
edge(f"file:{p}", f"class:{p}:InvokeProcedureUseCase", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:InvokeProcedureUseCase", "exports", 0.8)
edge(f"file:{p}", f"class:{p}:InvokeFailure", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:InvokeFailure", "exports", 0.8)
edge(f"class:{p}:InvokeProcedureUseCase", f"file:{P}procedure/InvokeBuiltinUseCase.ts", "calls", 0.8)
edge(f"class:{p}:InvokeProcedureUseCase", f"file:packages/mantle-runtime/src/domain/service/AuthPredicateEvaluator.ts", "calls", 0.8)

# procedure/index.ts
p = P+"procedure/index.ts"
fnode(p, "index.ts", "procedure usecase 的 barrel，匯出 InvokeProcedureUseCase、InvokeFailure 與 InvokeBuiltinUseCase。", ["barrel","entry-point","procedure"], "simple")

# render/index.ts
p = P+"render/index.ts"
fnode(p, "index.ts", "render usecase 的 barrel，匯出 llms.txt/sitemap 組譯、即時渲染與 SEO meta 組譯等 usecase。", ["barrel","entry-point","render"], "simple")

# view/index.ts
p = P+"view/index.ts"
fnode(p, "index.ts", "view usecase 的 barrel，匯出 ExecuteViewUseCase 及其回應型別。", ["barrel","entry-point","view"], "simple")

# ----- tests -----
# builtin-op.test.ts
p = T+"builtin-op.test.ts"
fnode(p, "builtin-op.test.ts", "內建 CRUD 操作的整合測試，透過 harness 組裝 InvokeBuiltin/InvokeProcedure 並驗證各 op 行為。", ["test","procedure","integration"], "complex")
funcnode(p, "harness", "組裝記憶體 repository、handler registry 與 invoke usecase 的測試夾具，回傳可操作的 entry/invoke 介面。", ["test","fixture"], "complex", [64,108])
funcnode(p, "builtinProcedure", "建構供測試使用的 builtin procedure manifest。", ["test","fixture"], "simple", [44,56])
funcnode(p, "nthIdGen", "回傳依序產生帶前綴 id 的測試用 IdGenerator。", ["test","fixture"], "simple", [20,23])
for fn in ["harness","builtinProcedure","nthIdGen"]:
    edge(f"file:{p}", f"function:{p}:{fn}", "contains", 1.0)
# tested_by
edge(f"file:{P}procedure/InvokeBuiltinUseCase.ts", f"file:{p}", "tested_by", 0.5)
edge(f"file:{P}procedure/InvokeProcedureUseCase.ts", f"file:{p}", "tested_by", 0.5)
edge(f"file:{P}lifecycle/RunLifecycleHooksUseCase.ts", f"file:{p}", "tested_by", 0.5)

# builtin-projector.test.ts
p = T+"builtin-projector.test.ts"
fnode(p, "builtin-projector.test.ts", "BuiltinProjector 投影與蓋章邏輯的單元測試。", ["test","data-model"], "moderate")
edge(f"file:packages/mantle-runtime/src/domain/service/BuiltinProjector.ts", f"file:{p}", "tested_by", 0.5)

# content-ops.test.ts
p = T+"content-ops.test.ts"
fnode(p, "content-ops.test.ts", "內容操作 usecase（草稿/發佈/下架/列表/i18n）的大型整合測試套件。", ["test","content","integration"], "complex")
funcnode(p, "harness", "組裝記憶體 repository 與 content usecase 的測試夾具。", ["test","fixture"], "moderate", [54,77])
funcnode(p, "translatedSchemas", "建構含翻譯關係的測試 schema 集合，驗證 i18n 發佈不變式。", ["test","fixture","i18n"], "moderate", [626,653])
funcnode(p, "fakeSiteConfig", "依語系清單建構假的 SiteConfig 供測試使用。", ["test","fixture"], "simple", [655,667])
for fn in ["harness","translatedSchemas","fakeSiteConfig"]:
    edge(f"file:{p}", f"function:{p}:{fn}", "contains", 1.0)
edge(f"file:{P}content/index.ts", f"file:{p}", "tested_by", 0.5)

# dispatcher-boot.test.ts
p = T+"dispatcher-boot.test.ts"
fnode(p, "dispatcher-boot.test.ts", "boot 驗證流程的整合測試，覆蓋 manifest 校驗與 ValidateBootUseCase 行為。", ["test","integration","validation"], "complex")
edge(f"file:packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts", f"file:{p}", "tested_by", 0.5)

# dispatcher-invoke.test.ts
p = T+"dispatcher-invoke.test.ts"
fnode(p, "dispatcher-invoke.test.ts", "procedure 派發呼叫的整合測試，驗證 InvokeProcedureUseCase 與 handler registry 互動。", ["test","procedure","integration"], "moderate")
funcnode(p, "fresh", "建立全新的測試用 handler registry 與 invoke usecase。", ["test","fixture"], "simple", [13,16])
edge(f"file:{p}", f"function:{p}:fresh", "contains", 1.0)
edge(f"file:{P}procedure/InvokeProcedureUseCase.ts", f"file:{p}", "tested_by", 0.5)

# entry-writer.test.ts
p = T+"entry-writer.test.ts"
fnode(p, "entry-writer.test.ts", "DatabaseEntryRepository 寫入路徑的整合測試，使用記憶體資料庫驗證持久化行為。", ["test","persistence","integration"], "complex")
edge(f"file:packages/mantle-runtime/src/infrastructure/persistence/DatabaseEntryRepository.ts", f"file:{p}", "tested_by", 0.5)

# fakes/in-memory-store.ts
p = T+"fakes/in-memory-store.ts"
fnode(p, "in-memory-store.ts", "測試用記憶體版 EntryRepository，以 Map 實作 CRUD、分頁與依資料欄位查詢。", ["test","fixture","persistence","data-model"], "moderate")
cnode(p, "InMemoryEntryRepository", "EntryRepository port 的記憶體實作，支援 create/update/list/findByDataField 等供測試使用。", ["test","fixture","persistence"], "complex", [35,163])
funcnode(p, "decodeOffsetCursor", "解碼偏移量分頁 cursor 字串為數字 offset。", ["test","utility","pagination"], "simple", [21,25])
edge(f"file:{p}", f"class:{p}:InMemoryEntryRepository", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:InMemoryEntryRepository", "exports", 0.8)
edge(f"file:{p}", f"function:{p}:decodeOffsetCursor", "contains", 1.0)

# fakes/manifests.ts
p = T+"fakes/manifests.ts"
fnode(p, "manifests.ts", "測試用 manifest 工廠集合，建構 schema/view/procedure/trigger 等假 manifest atom。", ["test","fixture","factory"], "moderate")
for fn,rng in [("postsSchema",[14,34]),("recentPostsView",[36,48]),("makeProcedure",[64,90]),("makeHttpTrigger",[92,111]),("makeLifecycleTrigger",[113,134]),("makeMcpTrigger",[136,150]),("makeBuiltinProcedure",[152,163])]:
    funcnode(p, fn, f"建構測試用 {fn} manifest atom。", ["test","fixture","factory"], "simple", rng)
    edge(f"file:{p}", f"function:{p}:{fn}", "contains", 1.0)
    edge(f"file:{p}", f"function:{p}:{fn}", "exports", 0.8)

# fakes/site-config.ts
p = T+"fakes/site-config.ts"
fnode(p, "site-config.ts", "測試用記憶體版 SiteConfigRepository，提供語系與媒體用途設定。", ["test","fixture","config"], "moderate")
cnode(p, "InMemorySiteConfigRepository", "SiteConfigRepository port 的記憶體實作，供測試載入語系與媒體 purpose 設定。", ["test","fixture","config"], "moderate", [9,47])
funcnode(p, "defaultPolicyForName", "依媒體用途名稱回傳預設政策設定。", ["test","fixture","utility"], "simple", [53,66])
edge(f"file:{p}", f"class:{p}:InMemorySiteConfigRepository", "contains", 1.0)
edge(f"file:{p}", f"class:{p}:InMemorySiteConfigRepository", "exports", 0.8)
edge(f"file:{p}", f"function:{p}:defaultPolicyForName", "contains", 1.0)

# lifecycle-hooks.test.ts
p = T+"lifecycle-hooks.test.ts"
fnode(p, "lifecycle-hooks.test.ts", "lifecycle hook 觸發與 deferred hook 派發的大型整合測試套件。", ["test","lifecycle","integration"], "complex")
funcnode(p, "harness", "組裝 handler registry、TriggerIndex 與 invoke usecase 的 lifecycle 測試夾具。", ["test","fixture"], "complex", [48,88])
edge(f"file:{p}", f"function:{p}:harness", "contains", 1.0)
edge(f"file:{P}lifecycle/index.ts", f"file:{p}", "tested_by", 0.5)
edge(f"file:{P}content/index.ts", f"file:{p}", "tested_by", 0.5)

# mcp.test.ts
p = T+"mcp.test.ts"
fnode(p, "mcp.test.ts", "MCP JSON-RPC dispatcher 的整合測試，覆蓋工具列舉與 procedure 呼叫等 MCP 協定行為。", ["test","mcp","integration"], "complex")
funcnode(p, "buildHarness", "組裝 McpJsonRpcDispatcher 與相依 usecase 的 MCP 測試夾具。", ["test","fixture","mcp"], "complex", [31,77])
funcnode(p, "minimalUseCases", "建構 MCP dispatcher 所需的最小 usecase 集合。", ["test","fixture"], "moderate", [85,118])
funcnode(p, "jsonRpcReq", "建構 JSON-RPC 請求物件供 MCP 測試使用。", ["test","fixture","mcp"], "simple", [120,126])
funcnode(p, "translatedSchemas", "建構含翻譯關係的測試 schema 集合。", ["test","fixture","i18n"], "moderate", [616,642])
for fn in ["buildHarness","minimalUseCases","jsonRpcReq","translatedSchemas"]:
    edge(f"file:{p}", f"function:{p}:{fn}", "contains", 1.0)
edge(f"file:packages/mantle-runtime/src/infrastructure/mcp/McpJsonRpcDispatcher.ts", f"file:{p}", "tested_by", 0.5)

# runtime.test.ts
p = T+"runtime.test.ts"
fnode(p, "runtime.test.ts", "createCmsRuntime 組裝根的整合測試，驗證 port 綁定與 boot 流程的端到端行為。", ["test","integration","entry-point"], "moderate")
edge(f"file:packages/mantle-runtime/src/runtime.ts", f"file:{p}", "tested_by", 0.5)

# trigger-index.test.ts
p = T+"trigger-index.test.ts"
fnode(p, "trigger-index.test.ts", "TriggerIndex 依 hook/HTTP/MCP 來源建索引與查詢的單元測試。", ["test","lifecycle"], "moderate")
edge(f"file:packages/mantle-runtime/src/domain/service/TriggerIndex.ts", f"file:{p}", "tested_by", 0.5)

out = {"nodes": nodes, "edges": edges}
with open('/Users/aotter/projects/aotter-clam-mantle-workroot/mantle/.understand-anything/intermediate/batch-2.json','w') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

imp = sum(1 for e in edges if e['type']=='imports')
print('nodes:', len(nodes), 'edges:', len(edges), 'imports:', imp)
