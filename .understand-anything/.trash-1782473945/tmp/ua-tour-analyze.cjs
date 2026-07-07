#!/usr/bin/env node
"use strict";

const fs = require("fs");

function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error("Usage: node ua-tour-analyze.js <input.json> <output.json>");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const nodes = raw.nodes || [];
  const edges = raw.edges || [];
  const layers = raw.layers || [];

  const nodeById = new Map();
  for (const n of nodes) nodeById.set(n.id, n);

  // --- Fan-in / Fan-out (count distinct neighbours, ignore self-loops) ---
  const fanInSet = new Map();
  const fanOutSet = new Map();
  for (const n of nodes) {
    fanInSet.set(n.id, new Set());
    fanOutSet.set(n.id, new Set());
  }
  for (const e of edges) {
    if (!e.source || !e.target || e.source === e.target) continue;
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    if (fanOutSet.has(e.source)) fanOutSet.get(e.source).add(e.target);
    if (fanInSet.has(e.target)) fanInSet.get(e.target).add(e.source);
  }

  const fanIn = new Map();
  const fanOut = new Map();
  for (const n of nodes) {
    fanIn.set(n.id, fanInSet.get(n.id).size);
    fanOut.set(n.id, fanOutSet.get(n.id).size);
  }

  const name = (id) => (nodeById.get(id) ? nodeById.get(id).name : id);

  const fanInRanking = [...fanIn.entries()]
    .map(([id, v]) => ({ id, fanIn: v, name: name(id) }))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 20);

  const fanOutRanking = [...fanOut.entries()]
    .map(([id, v]) => ({ id, fanOut: v, name: name(id) }))
    .sort((a, b) => b.fanOut - a.fanOut)
    .slice(0, 20);

  // --- Entry point candidates ---
  const fanOutVals = [...fanOut.values()].sort((a, b) => b - a);
  const top10pctIdx = Math.max(0, Math.floor(fanOutVals.length * 0.1) - 1);
  const top10pctThreshold = fanOutVals.length ? fanOutVals[top10pctIdx] : 0;

  const fanInValsAsc = [...fanIn.values()].sort((a, b) => a - b);
  const bottom25Idx = Math.max(0, Math.floor(fanInValsAsc.length * 0.25) - 1);
  const bottom25Threshold = fanInValsAsc.length ? fanInValsAsc[bottom25Idx] : 0;

  const codeEntryNames = new Set([
    "index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js",
    "server.ts", "server.js", "mod.rs", "main.go", "main.py", "main.rs",
    "manage.py", "app.py", "wsgi.py", "asgi.py", "run.py", "__main__.py",
    "Application.java", "Main.java", "Program.cs", "config.ru", "index.php",
    "App.swift", "Application.kt", "main.cpp", "main.c"
  ]);

  function depth(filePath) {
    if (!filePath) return 99;
    return filePath.split("/").filter(Boolean).length - 1; // 0 = root file
  }

  const scored = [];
  for (const n of nodes) {
    let score = 0;
    const fp = n.filePath || "";
    const isDoc = n.type === "document";
    if (isDoc) {
      if (n.name === "README.md" && depth(fp) === 0) score += 5;
      else if (/\.md$/i.test(n.name) && depth(fp) === 0) score += 2;
    } else if (n.type === "file") {
      if (codeEntryNames.has(n.name)) score += 3;
      const d = depth(fp);
      if (d <= 1) score += 1;
      if (fanOut.get(n.id) >= top10pctThreshold && top10pctThreshold > 0) score += 1;
      if (fanIn.get(n.id) <= bottom25Threshold) score += 1;
    }
    if (score > 0) {
      scored.push({ id: n.id, score, name: n.name, summary: n.summary || "" });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const entryPointCandidates = scored.slice(0, 5);

  // --- BFS from top CODE entry point ---
  // Build forward adjacency for imports + calls
  const fwdAdj = new Map();
  for (const n of nodes) fwdAdj.set(n.id, []);
  for (const e of edges) {
    if (e.type === "imports" || e.type === "calls") {
      if (nodeById.has(e.source) && nodeById.has(e.target) && e.source !== e.target) {
        fwdAdj.get(e.source).push(e.target);
      }
    }
  }

  // top code entry: highest scored non-document
  const codeEntries = scored.filter((c) => {
    const n = nodeById.get(c.id);
    return n && n.type !== "document";
  });
  // Prefer the declared project entry point if present
  const declaredEntry = "file:packages/mantle-runtime/src/index.ts";
  let startNode = null;
  if (nodeById.has(declaredEntry)) startNode = declaredEntry;
  else if (codeEntries.length) startNode = codeEntries[0].id;
  else if (nodes.length) startNode = nodes.find((n) => n.type === "file")?.id || nodes[0].id;

  const order = [];
  const depthMap = {};
  if (startNode) {
    const visited = new Set([startNode]);
    let frontier = [startNode];
    depthMap[startNode] = 0;
    order.push(startNode);
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const cur of frontier) {
        for (const nb of fwdAdj.get(cur) || []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            depthMap[nb] = d + 1;
            order.push(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
      d++;
    }
  }
  const byDepth = {};
  for (const [id, dp] of Object.entries(depthMap)) {
    (byDepth[dp] = byDepth[dp] || []).push(id);
  }

  // --- Non-code inventory ---
  const nonCodeFiles = { documentation: [], infrastructure: [], data: [], config: [] };
  for (const n of nodes) {
    const item = { id: n.id, name: n.name, type: n.type, summary: n.summary || "" };
    if (n.type === "document") nonCodeFiles.documentation.push(item);
    else if (["service", "pipeline", "resource"].includes(n.type)) nonCodeFiles.infrastructure.push(item);
    else if (["table", "schema", "endpoint"].includes(n.type)) nonCodeFiles.data.push(item);
    else if (n.type === "config") nonCodeFiles.config.push(item);
  }

  // --- Clusters: bidirectional import/call pairs, expand by shared membership ---
  const pairKey = (a, b) => (a < b ? a + "||" + b : b + "||" + a);
  const directed = new Map(); // "src||tgt" of imports/calls
  for (const e of edges) {
    if ((e.type === "imports" || e.type === "calls") && e.source !== e.target) {
      directed.set(e.source + "::" + e.target, true);
    }
  }
  const biPairs = [];
  const seenPair = new Set();
  for (const e of edges) {
    if ((e.type === "imports" || e.type === "calls") && e.source !== e.target) {
      if (directed.has(e.target + "::" + e.source)) {
        const k = pairKey(e.source, e.target);
        if (!seenPair.has(k)) {
          seenPair.add(k);
          biPairs.push([e.source, e.target]);
        }
      }
    }
  }
  // count edges between a set of nodes (any imports/calls direction)
  function edgeCountWithin(set) {
    let c = 0;
    for (const e of edges) {
      if ((e.type === "imports" || e.type === "calls") && set.has(e.source) && set.has(e.target)) c++;
    }
    return c;
  }
  const clusters = [];
  for (const [a, b] of biPairs) {
    const set = new Set([a, b]);
    // expand: add nodes connected to >=2 current members
    let changed = true;
    while (changed && set.size < 5) {
      changed = false;
      const candidateCount = new Map();
      for (const e of edges) {
        if (e.type !== "imports" && e.type !== "calls") continue;
        let other = null;
        if (set.has(e.source) && !set.has(e.target)) other = e.target;
        else if (set.has(e.target) && !set.has(e.source)) other = e.source;
        if (other) candidateCount.set(other, (candidateCount.get(other) || 0) + 1);
      }
      let best = null, bestC = 0;
      for (const [id, cnt] of candidateCount) {
        if (cnt >= 2 && cnt > bestC) { best = id; bestC = cnt; }
      }
      if (best) { set.add(best); changed = true; }
    }
    clusters.push({ nodes: [...set], edgeCount: edgeCountWithin(set) });
  }
  // dedup clusters by node-set signature, keep highest edgeCount
  const clusterBySig = new Map();
  for (const c of clusters) {
    const sig = [...c.nodes].sort().join("|");
    if (!clusterBySig.has(sig) || clusterBySig.get(sig).edgeCount < c.edgeCount) {
      clusterBySig.set(sig, c);
    }
  }
  const finalClusters = [...clusterBySig.values()]
    .sort((a, b) => b.edgeCount - a.edgeCount)
    .slice(0, 10);

  // --- Layers ---
  const layerOut = {
    count: layers.length,
    list: layers.map((l) => ({ id: l.id, name: l.name, description: l.description })),
  };

  // --- Node summary index ---
  const nodeSummaryIndex = {};
  for (const n of nodes) {
    nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary || "" };
  }

  const result = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal: { startNode, order, depthMap, byDepth },
    nonCodeFiles,
    clusters: finalClusters,
    layers: layerOut,
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
}
