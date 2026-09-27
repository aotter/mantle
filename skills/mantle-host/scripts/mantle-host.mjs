// mantle-host: generated from packages/mantle-host/src/host by scripts/build-host.mjs. Do not edit.

// src/host/entry.mjs
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/host/main.mjs
import { createHash as createHash4 } from "node:crypto";
import { readFile as readFile4, realpath as realpath4, stat } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// src/protocol.mjs
var hostProtocol = Object.freeze({ current: 1, minimum: 1 });
var hostProtocolHeader = "x-mantle-host-protocol";
var hostClientHeader = "x-mantle-host-client";

// package.json
var package_default = {
  name: "@aotter/mantle-host",
  private: false,
  version: "0.1.5-alpha.1",
  description: "Mantle hosting upload rules and source for the plugin host script.",
  license: "Apache-2.0",
  homepage: "https://mantle.tools/",
  repository: {
    type: "git",
    url: "git+https://github.com/aotter/mantle.git",
    directory: "packages/mantle-host"
  },
  type: "module",
  sideEffects: false,
  engines: {
    node: ">=22"
  },
  exports: {
    "./closed-module": {
      types: "./src/closed-module.d.mts",
      default: "./src/closed-module.mjs"
    },
    "./static-artifact": {
      types: "./src/static-artifact.d.mts",
      default: "./src/static-artifact.mjs"
    },
    "./source-zip": {
      types: "./src/source-zip.d.mts",
      default: "./src/source-zip.mjs"
    },
    "./bounded-body": {
      types: "./src/bounded-body.d.mts",
      default: "./src/bounded-body.mjs"
    },
    "./version": {
      types: "./src/version.d.mts",
      default: "./src/version.mjs"
    },
    "./protocol": {
      types: "./src/protocol.d.mts",
      default: "./src/protocol.mjs"
    },
    "./backend-artifact": {
      types: "./src/backend-artifact.d.mts",
      default: "./src/backend-artifact.mjs"
    },
    "./pack": {
      types: "./src/pack.d.mts",
      default: "./src/pack.mjs"
    },
    "./pack-backend": {
      types: "./src/pack-backend.d.mts",
      default: "./src/pack-backend.mjs"
    },
    "./host": {
      types: "./src/host/main.d.mts",
      default: "./src/host/main.mjs"
    },
    "./package.json": "./package.json"
  },
  scripts: {
    build: "node scripts/build-host.mjs",
    test: "node --test test/*.test.mjs",
    "check:generated": "node scripts/check-generated.mjs",
    check: "pnpm check:generated && pnpm test"
  },
  dependencies: {
    "es-module-lexer": "2.3.2",
    fflate: "0.8.3",
    esbuild: "0.28.1"
  },
  files: [
    "src",
    "README.md",
    "LICENSE"
  ]
};

// src/core.json
var core_default = {
  version: "0.1.5-alpha.1",
  revision: "35d2c142ba8dbe5d071b64d1b47ca4b722e0dcca"
};

// src/version.mjs
var cliPackage = package_default.name;
var cliVersion = package_default.version;
var hostName = "mantle-host";
var hostCommand = `${hostName} (the mantle plugin script; see the ${hostName} skill)`;
var updateHost = `Update the mantle plugin, or re-run \`npx skills add aotter/mantle --skill ${hostName}\`.`;
var corePin = Object.freeze({ version: core_default.version, revision: core_default.revision });

// ../../node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e2) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b3 = new u16(31);
  for (var i3 = 0; i3 < 31; ++i3) {
    b3[i3] = start += 1 << eb[i3 - 1];
  }
  var r2 = new i32(b3[30]);
  for (var i3 = 1; i3 < 30; ++i3) {
    for (var j = b3[i3]; j < b3[i3 + 1]; ++j) {
      r2[j] = j - b3[i3] << 5 | i3;
    }
  }
  return { b: b3, r: r2 };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r2) {
  var s2 = cd.length;
  var i3 = 0;
  var l2 = new u16(mb);
  for (; i3 < s2; ++i3) {
    if (cd[i3])
      ++l2[cd[i3] - 1];
  }
  var le = new u16(mb);
  for (i3 = 1; i3 < mb; ++i3) {
    le[i3] = le[i3 - 1] + l2[i3 - 1] << 1;
  }
  var co;
  if (r2) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i3 = 0; i3 < s2; ++i3) {
      if (cd[i3]) {
        var sv = i3 << 4 | cd[i3];
        var r_1 = mb - cd[i3];
        var v = le[cd[i3] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s2);
    for (i3 = 0; i3 < s2; ++i3) {
      if (cd[i3]) {
        co[i3] = rev[le[cd[i3] - 1]++] >> 15 - cd[i3];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a2) {
  var m = a2[0];
  for (var i3 = 1; i3 < a2.length; ++i3) {
    if (a2[i3] > m)
      m = a2[i3];
  }
  return m;
};
var bits = function(d, p, m) {
  var o2 = p / 8 | 0;
  return (d[o2] | d[o2 + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o2 = p / 8 | 0;
  return (d[o2] | d[o2 + 1] << 8 | d[o2 + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s2, e2) {
  if (s2 == null || s2 < 0)
    s2 = 0;
  if (e2 == null || e2 > v.length)
    e2 = v.length;
  return new u8(v.subarray(s2, e2));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e2 = new Error(msg || ec[ind]);
  e2.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e2, err);
  if (!nt)
    throw e2;
  return e2;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l3) {
    var bl = buf.length;
    if (l3 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l3));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s2 = shft(pos) + 4, l2 = dat[s2 - 4] | dat[s2 - 3] << 8, t2 = s2 + l2;
        if (t2 > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l2);
        buf.set(dat.subarray(s2, t2), bt);
        st.b = bt += l2, st.p = pos = t2 * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i3 = 0; i3 < hcLen; ++i3) {
          clt[clim[i3]] = bits(dat, pos + i3 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i3 = 0; i3 < tl; ) {
          var r2 = clm[bits(dat, pos, clbmsk)];
          pos += r2 & 15;
          var s2 = r2 >> 4;
          if (s2 < 16) {
            ldt[i3++] = s2;
          } else {
            var c2 = 0, n2 = 0;
            if (s2 == 16)
              n2 = 3 + bits(dat, pos, 3), pos += 2, c2 = ldt[i3 - 1];
            else if (s2 == 17)
              n2 = 3 + bits(dat, pos, 7), pos += 3;
            else if (s2 == 18)
              n2 = 11 + bits(dat, pos, 127), pos += 7;
            while (n2--)
              ldt[i3++] = c2;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c2 = lm[bits16(dat, pos) & lms], sym = c2 >> 4;
      pos += c2 & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c2)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i3 = sym - 257, b3 = fleb[i3];
          add = bits(dat, pos, (1 << b3) - 1) + fl[i3];
          pos += b3;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b3 = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b3) - 1, pos += b3;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b3) {
  return d[b3] | d[b3 + 1] << 8;
};
var b4 = function(d, b3) {
  return (d[b3] | d[b3 + 1] << 8 | d[b3 + 2] << 16 | d[b3 + 3] << 24) >>> 0;
};
var b8 = function(d, b3) {
  return b4(d, b3) + b4(d, b3 + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e2) {
}
var dutf8 = function(d) {
  for (var r2 = "", i3 = 0; ; ) {
    var c2 = d[i3++];
    var eb = (c2 > 127) + (c2 > 223) + (c2 > 239);
    if (i3 + eb > d.length)
      return { s: r2, r: slc(d, i3 - 1) };
    if (!eb)
      r2 += String.fromCharCode(c2);
    else if (eb == 3) {
      c2 = ((c2 & 15) << 18 | (d[i3++] & 63) << 12 | (d[i3++] & 63) << 6 | d[i3++] & 63) - 65536, r2 += String.fromCharCode(55296 | c2 >> 10, 56320 | c2 & 1023);
    } else if (eb & 1)
      r2 += String.fromCharCode((c2 & 31) << 6 | d[i3++] & 63);
    else
      r2 += String.fromCharCode((c2 & 15) << 12 | (d[i3++] & 63) << 6 | d[i3++] & 63);
  }
};
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i3 = 0; i3 < str.length; ++i3)
      ar_1[i3] = str.charCodeAt(i3);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l2 = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i3 = 0; i3 < l2; ++i3) {
    if (ai + 5 > ar.length) {
      var n2 = new u8(ai + 8 + (l2 - i3 << 1));
      n2.set(ar);
      ar = n2;
    }
    var c2 = str.charCodeAt(i3);
    if (c2 < 128 || latin1)
      w(c2);
    else if (c2 < 2048)
      w(192 | c2 >> 6), w(128 | c2 & 63);
    else if (c2 > 55295 && c2 < 57344)
      c2 = 65536 + (c2 & 1023 << 10) | str.charCodeAt(++i3) & 1023, w(240 | c2 >> 18), w(128 | c2 >> 12 & 63), w(128 | c2 >> 6 & 63), w(128 | c2 & 63);
    else
      w(224 | c2 >> 12), w(128 | c2 >> 6 & 63), w(128 | c2 & 63);
  }
  return slc(ar, 0, ai);
}
function strFromU8(dat, latin1) {
  if (latin1) {
    var r2 = "";
    for (var i3 = 0; i3 < dat.length; i3 += 16384)
      r2 += String.fromCharCode.apply(null, dat.subarray(i3, i3 + 16384));
    return r2;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s2 = _a2.s, r2 = _a2.r;
    if (r2.length)
      err(8);
    return s2;
  }
}
var slzh = function(d, b3) {
  return b3 + 30 + b2(d, b3 + 26) + b2(d, b3 + 28);
};
var zh = function(d, b3, z) {
  var fnl = b2(d, b3 + 28), efl = b2(d, b3 + 30), fn = strFromU8(d.subarray(b3 + 46, b3 + 46 + fnl), !(b2(d, b3 + 8) & 2048)), es = b3 + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b3 + 20), b4(d, b3 + 24), b4(d, b3 + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b3 + 10), sc, su, fn, es + efl + b2(d, b3 + 32), off];
};
var z64hs = function(d, b3, l2, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e2 = b3 + l2;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b3 + 4 < e2; b3 += 4 + b2(d, b3 + 2)) {
      if (b2(d, b3) == 1) {
        return [
          nsc ? b8(d, b3 + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b3 + 4) : su,
          noff ? b8(d, b3 + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e2 = data.length - 22;
  for (; b4(data, e2) != 101010256; --e2) {
    if (!e2 || data.length - e2 > 65558)
      err(13);
  }
  ;
  var c2 = b2(data, e2 + 8);
  if (!c2)
    return {};
  var o2 = b4(data, e2 + 16);
  var z = b4(data, e2 - 20) == 117853008;
  if (z) {
    var ze = b4(data, e2 - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c2 = b4(data, ze + 32);
      o2 = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i3 = 0; i3 < c2; ++i3) {
    var _a2 = zh(data, o2, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b3 = slzh(data, off);
    o2 = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b3, b3 + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b3, b3 + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/static-artifact.mjs
var CloudRuleError = class extends Error {
  constructor(status2, code, detail) {
    super(code);
    this.status = status2;
    this.code = code;
    if (detail !== void 0) this.detail = detail;
  }
};
var staticFrontendLimit = 9e6;
var staticAssetLimit = 6e6;
var staticAssetCount = 100;
var staticMimeTypes = Object.freeze({
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".map": "application/json"
});
var mime = new Map(Object.entries(staticMimeTypes));
var mantleReservedPathPrefixes = Object.freeze(["/admin", "/_mantle", "/api/auth", "/api/views", "/oauth", "/mcp"]);
var mantleReservedWellKnownPrefix = "/.well-known/oauth";
var mantleReservedExactPaths = Object.freeze(["*", "/*"]);
var cloudReservedPrefixes = Object.freeze(["/api", "/__cloud", "/_app"]);
var cloudReservedExactPaths = Object.freeze(["/terms", "/privacy"]);
var reservedWebPaths = Object.freeze(["/favicon.ico", "/robots.txt", "/llms.txt", "/llms-full.txt", "/sitemap.xml", "/sitemap-index.xml"]);
var reservedWeb = new Set(reservedWebPaths);
var owned = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}*`) || path.startsWith(`${prefix}{`);
function reservedStaticPath(path) {
  return mantleReservedExactPaths.includes(path) || mantleReservedPathPrefixes.some((prefix) => owned(path, prefix)) || path.startsWith(mantleReservedWellKnownPrefix) || cloudReservedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/")) || cloudReservedExactPaths.includes(path) || reservedWeb.has(path) || /^\/(?:\.well-known|terms|privacy)\//.test(path);
}
var textual = (type) => type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";
function inspectStaticAssets(assets, reserved = () => false) {
  const entries = Object.entries(assets);
  if (!entries.length || entries.length > staticAssetCount || !Object.hasOwn(assets, "/index.html")) throw new CloudRuleError(400, "static_assets_invalid");
  let total = 0;
  const names = /* @__PURE__ */ new Set();
  for (const [path, asset] of entries) {
    const normalized2 = path.normalize("NFC").toLowerCase();
    if (!path.startsWith("/") || path.endsWith("/") || path !== path.normalize("NFC") || /[%?#\\\u0000- ]/.test(path) || path.split("/").slice(1).some((part) => !part || part === "." || part === "..") || new URL(path, "https://tenant.invalid").pathname !== path || names.has(normalized2) || reservedStaticPath(normalized2) || reserved(normalized2))
      throw new CloudRuleError(400, "static_asset_path_invalid", path);
    names.add(normalized2);
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (asset.type !== mime.get(extension)) throw new CloudRuleError(400, "static_asset_mime_invalid", path);
    let bytes;
    try {
      bytes = atob(asset.base64);
    } catch {
      throw new CloudRuleError(400, "static_asset_base64_invalid", path);
    }
    if (btoa(bytes) !== asset.base64) throw new CloudRuleError(400, "static_asset_base64_invalid", path);
    total += bytes.length;
    if (total > staticAssetLimit) throw new CloudRuleError(400, "static_assets_too_large", path);
    if (textual(asset.type)) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes, (character) => character.charCodeAt(0)));
      } catch {
        throw new CloudRuleError(400, "static_asset_utf8_invalid", path);
      }
    }
  }
  return { bytes: total };
}
var staticMimeFor = (path) => mime.get(path.slice(path.lastIndexOf(".")).toLowerCase());
function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function serializeStaticArtifact(files, { sdkRevision, spa }) {
  const assets = /* @__PURE__ */ Object.create(null);
  for (const path of Object.keys(files).sort((a2, b3) => a2 < b3 ? -1 : a2 > b3 ? 1 : 0)) {
    const type = staticMimeFor(path);
    if (!type) throw new CloudRuleError(400, "static_asset_mime_invalid", path);
    assets[path] = { base64: base64(files[path]), type };
  }
  const text = JSON.stringify({ version: 2, sdkRevision, spa: Boolean(spa), assets });
  if (new TextEncoder().encode(text).byteLength > staticFrontendLimit) throw new CloudRuleError(400, "static_frontend_too_large");
  inspectStaticAssets(assets);
  return text;
}

// src/host/output.mjs
var fail = (code, detail, status2 = 400) => new CloudRuleError(status2, code, detail);
var shellWord = (word) => /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`;
var redact = (text) => String(text).replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/([?&](?:token|sig|signature)=)[^&\s"']+/gi, "$1[redacted]").replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]");
function createOutput({ json = false, write = (text) => process.stdout.write(text) } = {}) {
  const secrets = /* @__PURE__ */ new Set();
  const scrub = (text) => redact([...secrets].reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text));
  const human = (line) => {
    const head = [
      line.stage,
      line.ok === false ? `failed: ${line.error}` : line.state,
      line.versionId ? `version ${line.versionId}` : null,
      line.commit ? `commit ${line.commit}` : null
    ].filter(Boolean).join(" · ");
    const rows = [head];
    if (line.detail) rows.push(`  ${line.detail}`);
    for (const note of line.notes ?? []) rows.push(`  ${note}`);
    const next = line.nextAction;
    if (next) {
      for (const look of next.confirm ?? []) rows.push(`  confirm with the user: ${look.field} from ${look.tool} ${JSON.stringify(look.arguments)}`);
      if (next.tool) rows.push(`  next: call ${next.tool} ${JSON.stringify(next.arguments ?? {})}`);
      for (const need of next.requires ?? []) rows.push(`    ${need.argument} = ${need.field} from ${need.tool} ${JSON.stringify(need.arguments)}`);
      if (next.command) rows.push(`  ${next.tool ? "then" : "next"}: ${next.command}`);
      if (next.reason) rows.push(`  ${next.reason}`);
    }
    return rows.join("\n");
  };
  return {
    /** Registers a credential so no later line can print it. */
    remember(value) {
      if (typeof value === "string" && value.length >= 8) secrets.add(value);
    },
    emit(line) {
      const text = json ? JSON.stringify(line) : human(line);
      const safe = scrub(text);
      write((json && safe !== text ? JSON.stringify({ ok: false, stage: line.stage, error: "output_redacted", nextAction: null }) : safe) + "\n");
    }
  };
}
function failureLine(stage, error, nextAction) {
  const code = error instanceof CloudRuleError ? error.code : "local_error";
  const detail = error instanceof CloudRuleError ? error.detail : error instanceof Error ? error.message : String(error);
  return { ok: false, stage, error: code, ...detail ? { detail: String(detail).slice(0, 2e3) } : {}, nextAction };
}

// src/host/cloud.mjs
var cloudOrigins = Object.freeze(["https://cloud.mantle.tools", "https://cloud-staging.mantle.tools"]);
var kitFiles = Object.freeze(["AGENT.md", "frontend-contract.json", "kit.json", "mantle-client.ts", "openapi.json"]);
var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var hex64 = /^[a-f0-9]{64}$/;
var kitLimit = 4e6;
var loopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
function unwrapResult(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Object.hasOwn(value, key)) return value;
  for (const field of ["structuredContent", "result", "data", "output"]) {
    const found = unwrapResult(value[field], key, depth + 1);
    if (found) return found;
  }
  if (Array.isArray(value.content)) for (const item of value.content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const found = unwrapResult(JSON.parse(item.text), key, depth + 1);
      if (found) return found;
    } catch {
    }
  }
  return null;
}
function decodeInput(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
  if (view[0] === 255 && view[1] === 254) return new TextDecoder("utf-16le").decode(view.subarray(2));
  return new TextDecoder("utf-8").decode(view).replace(/^﻿/, "");
}
function grantUrl(raw, path, { origin, query = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail("grant_url_invalid");
  }
  if (!cloudOrigins.includes(url.origin) && !loopback(url) || url.username || url.password || url.hash || url.pathname !== path || !query && url.search || origin && url.origin !== origin) throw fail("grant_url_invalid", origin && url.origin !== origin ? "grant URLs name different origins" : void 0);
  return url;
}
function rememberCredentials(value, output, key = "", depth = 0) {
  if (depth > 12) return;
  if (typeof value === "string") {
    if (/authorization|token|secret|url/i.test(key) || /^Bearer /.test(value)) {
      output.remember(value);
      output.remember(value.replace(/^Bearer /, ""));
    }
    try {
      for (const item of new URL(value).searchParams.values()) output.remember(item);
    } catch {
    }
    if (value.startsWith("{")) try {
      rememberCredentials(JSON.parse(value), output, key, depth + 1);
    } catch {
    }
  } else if (value && typeof value === "object") for (const [name2, item] of Object.entries(value)) rememberCredentials(item, output, name2, depth + 1);
}
function bearerOf(grant, output) {
  const value = grant?.authorization;
  if (typeof value !== "string" || !/^Bearer [A-Za-z0-9._~+/=-]{16,}$/.test(value)) throw fail("grant_authorization_invalid");
  output.remember(value);
  output.remember(value.slice(7));
  return value;
}
function checkProtocol(protocol) {
  if (protocol && typeof protocol === "object" && Number(protocol.minimum) > hostProtocol.current)
    throw fail("client_outdated", `Cloud requires mantle-host protocol ${Number(protocol.minimum)}; this script speaks ${hostProtocol.current}`, 409);
}
async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw fail("download_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function cloudClient({ fetch: request, client }) {
  const headers = { [hostProtocolHeader]: String(hostProtocol.current), [hostClientHeader]: client };
  async function call(url, { method = "GET", authorization, body, type, timeout }) {
    let response;
    try {
      response = await request(url, {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: { ...headers, ...authorization ? { authorization } : {}, ...type ? { "content-type": type } : {} }
      });
    } catch {
      throw fail("cloud_unreachable", void 0, 503);
    }
    if (response.status === 426) throw fail("client_outdated", "Cloud answered 426 client_outdated", 409);
    return response;
  }
  return {
    async json(url, init) {
      const response = await call(url, init);
      let body = null;
      try {
        body = JSON.parse(new TextDecoder().decode(await boundedBody(response, 4e6)));
      } catch (error) {
        if (error.code === "download_too_large") throw error;
      }
      if (!response.ok) {
        const code = typeof body?.error === "string" && /^[a-z0-9_]{1,100}$/.test(body.error) ? body.error : response.status === 403 ? "upload_grant_rejected" : response.status === 413 ? "upload_too_large" : response.status >= 500 ? "cloud_unavailable" : "cloud_request_failed";
        throw fail(code, `HTTP ${response.status}`, response.status >= 500 ? 503 : response.status === 409 ? 409 : 400);
      }
      if (!body || typeof body !== "object") throw fail("cloud_response_invalid");
      checkProtocol(body.protocol);
      return body;
    },
    async bytes(url, { limit, timeout }) {
      const response = await call(url, { timeout });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw fail(typeof body?.error === "string" && /^[a-z0-9_]{1,100}$/.test(body.error) ? body.error : "kit_download_failed", `HTTP ${response.status}`, response.status === 409 ? 409 : 400);
      }
      return boundedBody(response, limit);
    }
  };
}
function extractKit(bytes, { candidateId, contractHash }) {
  const names = [];
  let entries;
  try {
    entries = unzipSync(bytes, { filter: (file) => {
      if (!kitFiles.includes(file.name) || names.includes(file.name) || file.originalSize > kitLimit) throw fail("kit_entry_invalid");
      names.push(file.name);
      return true;
    } });
  } catch (error) {
    throw error?.code ? error : fail("kit_invalid");
  }
  if (names.length !== kitFiles.length) throw fail("kit_entry_invalid", "missing entries");
  let kit;
  try {
    kit = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries["kit.json"]));
  } catch {
    throw fail("kit_invalid");
  }
  if (kit.candidateId !== candidateId || kit.contractHash !== contractHash) throw fail("kit_contract_mismatch");
  if (kit.coreRevision !== corePin.revision) throw fail("cli_core_mismatch", `kit pins Core ${String(kit.coreRevision).slice(0, 64)}`, 409);
  return { kit, entries };
}
var kitLimitBytes = kitLimit;

// src/host/link.mjs
import { createHash } from "node:crypto";

// src/host/files.mjs
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
function safeRelative(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return false;
  if (value === "" || value === ".") return allowEmpty;
  return value.length <= 200 && value === value.normalize("NFC") && !/[\\:\u0000-\u001f\u007f]/.test(value) && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}
var normalized = (value) => value === "." ? "" : value.replace(/\/+$/, "");
var joinRelative = (...parts) => parts.map((part) => normalized(part ?? "")).filter(Boolean).join("/");
async function walk(project, rel, create) {
  let path = project;
  const parts = rel.split("/").filter(Boolean);
  for (const part of parts) {
    path = join(path, part);
    const stat2 = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat2 && !stat2.isDirectory()) throw fail("host_path_unsafe", rel);
    if (!stat2) {
      if (!create) return null;
      await mkdir(path);
    }
  }
  return path;
}
var ensureDir = (project, rel) => walk(project, rel, true);
async function readInside(project, rel, limit) {
  const parts = rel.split("/");
  const dir = await walk(project, parts.slice(0, -1).join("/"), false);
  if (!dir) return null;
  const path = join(dir, parts.at(-1));
  const stat2 = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat2) return null;
  if (!stat2.isFile()) throw fail("host_path_unsafe", rel);
  if (stat2.size > limit) throw fail("host_file_too_large", rel);
  return new Uint8Array(await readFile(path));
}
async function writeAtomic(project, rel, bytes, mode = 420) {
  const parts = rel.split("/");
  const dir = await ensureDir(project, parts.slice(0, -1).join("/"));
  const path = join(dir, parts.at(-1)), temporary = `${path}.${randomUUID()}.tmp`;
  const stat2 = await lstat(path).catch(() => null);
  if (stat2 && !stat2.isFile()) throw fail("host_path_unsafe", rel);
  await writeFile(temporary, bytes, { flag: "wx", mode });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}
async function appendInside(project, rel, text) {
  const parts = rel.split("/");
  const path = join(await ensureDir(project, parts.slice(0, -1).join("/")), parts.at(-1));
  const stat2 = await lstat(path).catch(() => null);
  if (stat2 && !stat2.isFile()) throw fail("host_path_unsafe", rel);
  await appendFile(path, text, { flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) });
}
async function resetDir(project, rel) {
  const path = await ensureDir(project, rel);
  await rm(path, { recursive: true, force: true });
  await mkdir(path);
  return path;
}
var inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

// src/host/link.mjs
var linkFile = ".mantle/hosting.json";
var runtimes = Object.freeze(["mantle-cloud", "cloudflare", "chatgpt-sites"]);
var defaultHandlers = "handlers/index.ts";
var uuid2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var name = /^[a-z][a-z0-9-]{0,39}$/;
var slugRule = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
var secretKey = /token|secret|password|passwd|key|auth|cookie|bearer|credential|session/i;
var tokenShaped = (value) => /Bearer\s|eyJ[A-Za-z0-9_-]{8,}/i.test(value) || (value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []).some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run) || /^[a-f0-9]+$/i.test(run));
var pointer = (parts) => parts.map((part) => "/" + String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("");
var invalid = (parts, why) => fail("link_file_invalid", `${pointer(parts) || "/"}: ${why}`);
var configPath = (value, extensions) => safeRelative(value) && extensions.some((extension) => value.endsWith(extension));
var shapes = {
  "mantle-cloud": {
    runtime: [true, (value) => value === "mantle-cloud"],
    organizationId: [true, (value) => uuid2.test(value)],
    projectId: [true, (value) => uuid2.test(value)],
    slug: [true, (value) => slugRule.test(value)],
    root: [false, (value) => safeRelative(value, { allowEmpty: true })],
    handlers: [false, (value) => safeRelative(value) && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(value)],
    frontend: [false, (value) => value && typeof value === "object" && !Array.isArray(value)]
  },
  cloudflare: { runtime: [true, (value) => value === "cloudflare"], config: [false, (value) => configPath(value, [".json", ".jsonc", ".toml"])] },
  "chatgpt-sites": { runtime: [true, (value) => value === "chatgpt-sites"], config: [false, (value) => configPath(value, [".json"])] }
};
var frontendShape = {
  dist: [false, (value) => safeRelative(value) && !value.split("/").some((part) => [".git", ".mantle", "node_modules"].includes(part.toLowerCase()))],
  spa: [false, (value) => typeof value === "boolean"],
  build: [false, (value) => typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)]
};
function scan(value, parts = []) {
  if (Array.isArray(value)) throw invalid(parts, "arrays are not allowed");
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (tokenShaped(key)) throw invalid(parts, "token-shaped key");
    if (secretKey.test(key)) throw invalid([...parts, key], "secret-shaped key; the link file never holds credentials");
    scan(item, [...parts, key]);
  }
  else if (typeof value === "string" && tokenShaped(value)) throw invalid(parts, "token-shaped value; the link file never holds credentials");
}
function check(object, shape, parts) {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw invalid(parts, "expected an object");
  for (const key of Object.keys(object)) if (!Object.hasOwn(shape, key)) throw invalid([...parts, key], "unknown key (the link file has no endpoint, origin or credential settings)");
  for (const [key, [required, test]] of Object.entries(shape)) {
    if (!Object.hasOwn(object, key)) {
      if (required) throw invalid([...parts, key], "required");
      continue;
    }
    if (!test(object[key])) throw invalid([...parts, key], "invalid value");
  }
}
function validateLink(doc) {
  scan(doc);
  check(doc, { schemaVersion: [true, (value) => value === 1], targets: [true, (value) => value && typeof value === "object"] }, []);
  const names = Object.keys(doc.targets);
  if (!names.length || names.length > 20) throw invalid(["targets"], "one to 20 targets");
  for (const target of names) {
    if (!name.test(target)) throw invalid(["targets", target], "target names are lowercase letters, digits and dashes");
    const entry = doc.targets[target];
    if (!entry || typeof entry !== "object" || !runtimes.includes(entry.runtime)) throw invalid(["targets", target, "runtime"], `one of ${runtimes.join(", ")}`);
    check(entry, shapes[entry.runtime], ["targets", target]);
    if (entry.frontend) check(entry.frontend, frontendShape, ["targets", target, "frontend"]);
  }
  return doc;
}
async function readLink(project) {
  const bytes = await readInside(project, linkFile, 64e3);
  if (!bytes) return null;
  let doc;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""));
  } catch {
    throw fail("link_file_invalid", "/: not UTF-8 JSON");
  }
  return validateLink(doc);
}
async function writeLink(project, doc) {
  await writeAtomic(project, linkFile, JSON.stringify(validateLink(doc), null, 2) + "\n");
}
function pickTarget(doc, requested) {
  if (!doc) throw fail("link_file_missing", `run link to create ${linkFile}`);
  const names = Object.keys(doc.targets);
  if (requested !== void 0 && !Object.hasOwn(doc.targets, requested)) throw fail("link_target_unknown", `targets: ${names.join(", ")}`);
  if (requested === void 0 && names.length > 1) throw fail("link_target_required", `pass --target with one of: ${names.join(", ")}`);
  const target = requested ?? names[0], entry = doc.targets[target];
  const hash = createHash("sha256").update(canonical(entry)).digest("hex");
  if (entry.runtime !== "mantle-cloud") return { target, entry, hash };
  return { target, hash, entry: {
    ...entry,
    root: entry.root === "." ? "" : entry.root ?? "",
    handlers: entry.handlers ?? defaultHandlers,
    frontend: { dist: entry.frontend?.dist ?? "dist", spa: entry.frontend?.spa ?? false, build: entry.frontend?.build ?? null }
  } };
}
var canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

// src/host/state.mjs
var hostDir = ".mantle/host";
var stateFile = `${hostDir}/state.json`;
var outDir = (target) => `${hostDir}/out/${target}`;
async function loadState(project) {
  const bytes = await readInside(project, stateFile, 4e6);
  if (!bytes) return { schemaVersion: 1, targets: {} };
  let state;
  try {
    state = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    state = null;
  }
  if (state?.schemaVersion !== 1 || !state.targets || typeof state.targets !== "object") throw fail("state_invalid", `delete ${stateFile} and run save again`);
  return state;
}
async function saveState(project, state) {
  const text = JSON.stringify(state, null, 2) + "\n";
  if (redact(text) !== text) throw fail("state_secret_refused");
  await writeAtomic(project, stateFile, text, 384);
}
var targetState = (state, target) => state.targets[target] ??= { confirmedLink: null, pending: null, versions: [], deploys: {}, rollbacks: {} };

// src/host/save.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { join as join6, relative as relative4, sep as sep5 } from "node:path";
import { realpath as realpath3, stat as statPath, writeFile as writeFile3 } from "node:fs/promises";

// src/pack.mjs
import { lstat as lstat2, mkdir as mkdir2, readFile as readFile2, readdir, realpath, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2, relative, resolve, sep as sep2 } from "node:path";
import { createHash as createHash3 } from "node:crypto";

// src/source-zip.mjs
var sourceExpandedLimit = 4e7;
var sourceArchiveLimit = 42e6;
var sourceEntryLimit = 2e3;
var sourcePathLimit = 300;
var secretPathNames = Object.freeze([".env", ".dev.vars", "id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials.json"]);
var secretPathSuffixes = Object.freeze([".pem", ".key", ".p12", ".pfx"]);
var secretTemplateNames = Object.freeze([".env.example", ".env.sample", ".dev.vars.example"]);
var u162 = (bytes, at) => bytes[at] | bytes[at + 1] << 8;
var u32 = (bytes, at) => (u162(bytes, at) | u162(bytes, at + 2) << 16) >>> 0;
var invalid2 = () => new CloudRuleError(400, "source_archive_invalid");
var expansion = () => new CloudRuleError(400, "source_archive_expansion_limit");
function secretSourcePath(path) {
  const parts = path.toLowerCase().split("/");
  return parts.some((part, index) => !(index === parts.length - 1 && secretTemplateNames.includes(part)) && (secretPathNames.includes(part) || part.startsWith(".env.") || part.startsWith(".dev.vars.") || secretPathSuffixes.some((suffix) => part.endsWith(suffix))));
}
var omittablePath = (path) => typeof path === "string" && path.length > 0 && path.length <= sourcePathLimit && path === path.normalize("NFC") && path.trim() === path && !path.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..");
function sourcePathKey(path) {
  if (!path || path.length > sourcePathLimit || path.startsWith("/") || path.endsWith("/") || path.trim() !== path || path !== path.normalize("NFC") || /[%:#?\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new CloudRuleError(400, "source_archive_path_invalid", path);
  if (secretSourcePath(path)) throw new CloudRuleError(400, "source_archive_secret_path", path);
  return path.toLowerCase();
}
var dosDate = 33;
var encoder = new TextEncoder();
var crcTable = Uint32Array.from({ length: 256 }, (_, n2) => {
  let c2 = n2;
  for (let k2 = 0; k2 < 8; k2++) c2 = c2 & 1 ? 3988292384 ^ c2 >>> 1 : c2 >>> 1;
  return c2 >>> 0;
});
var crc32 = (bytes) => {
  let c2 = ~0;
  for (let i3 = 0; i3 < bytes.length; i3++) c2 = crcTable[(c2 ^ bytes[i3]) & 255] ^ c2 >>> 8;
  return ~c2 >>> 0;
};
var put16 = (out, at, value) => {
  out[at] = value & 255;
  out[at + 1] = value >>> 8 & 255;
};
var put32 = (out, at, value) => {
  put16(out, at, value & 65535);
  put16(out, at + 2, value >>> 16);
};
var byName = (a2, b3) => a2 < b3 ? -1 : a2 > b3 ? 1 : 0;
function header({ name: name2, utf8: utf82, crc, size, offset }, central) {
  const out = new Uint8Array((central ? 46 : 30) + name2.length);
  put32(out, 0, central ? 33639248 : 67324752);
  let at = 4;
  if (central) put16(out, at, 20), at += 2;
  put16(out, at, 20);
  put16(out, at + 2, utf82 ? 2048 : 0);
  put16(out, at + 4, 0);
  put16(out, at + 6, 0);
  put16(out, at + 8, dosDate);
  put32(out, at + 10, crc);
  put32(out, at + 14, size);
  put32(out, at + 18, size);
  put16(out, at + 22, name2.length);
  put16(out, at + 24, 0);
  at += 26;
  if (central) {
    put16(out, at, 0);
    put16(out, at + 2, 0);
    put16(out, at + 4, 0);
    put32(out, at + 6, 0);
    put32(out, at + 10, offset);
    at += 14;
  }
  out.set(name2, at);
  return out;
}
function canonicalSourceZip(files) {
  let offset = 0;
  const entries = Object.keys(files).sort(byName).map((path) => {
    const bytes = files[path], name2 = encoder.encode(path);
    const entry = { name: name2, utf8: name2.length !== path.length, crc: crc32(bytes), size: bytes.length, offset, bytes };
    offset += 30 + name2.length + bytes.length;
    return entry;
  });
  const central = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const out = new Uint8Array(offset + central + 22);
  let at = 0;
  for (const entry of entries) {
    const local = header(entry, false);
    out.set(local, at);
    out.set(entry.bytes, at + local.length);
    at += local.length + entry.size;
  }
  for (const entry of entries) {
    const record = header(entry, true);
    out.set(record, at);
    at += record.length;
  }
  put32(out, at, 101010256);
  put16(out, at + 8, entries.length);
  put16(out, at + 10, entries.length);
  put32(out, at + 12, central);
  put32(out, at + 16, offset);
  return out;
}
function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i3 = 0; i3 < left.byteLength; i3++) if (left[i3] !== right[i3]) return false;
  return true;
}
var manifestPath = (path) => /^manifests\/.*\.ya?ml$/i.test(path);
var zip64Marker = 4294967295;
function directory(bytes) {
  const end = bytes.byteLength - 22;
  if (end < 0 || u32(bytes, end) !== 101010256 || u162(bytes, end + 4) || u162(bytes, end + 6) || u162(bytes, end + 8) !== u162(bytes, end + 10) || u162(bytes, end + 20)) throw invalid2();
  if (end >= 20 && u32(bytes, end - 20) === 117853008) throw invalid2();
  const count = u162(bytes, end + 10), cdOffset = u32(bytes, end + 16), cdSize = u32(bytes, end + 12);
  if (count === 65535 || cdOffset === zip64Marker || cdSize === zip64Marker) throw invalid2();
  if (!count || count > sourceEntryLimit) throw expansion();
  if (cdOffset + cdSize !== end) throw invalid2();
  const seen = /* @__PURE__ */ new Set(), entries = [];
  let expanded = 0, at = cdOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(bytes, at) !== 33639248) throw invalid2();
    const record = at, stored = u162(bytes, at + 10) === 0, compressed = u32(bytes, at + 20), size = u32(bytes, at + 24), local = u32(bytes, at + 42);
    if ([compressed, size, local].includes(zip64Marker) || u162(bytes, at + 30) || u162(bytes, at + 32)) throw invalid2();
    const nameEnd = at + 46 + u162(bytes, at + 28);
    if (nameEnd > end) throw invalid2();
    let name2;
    try {
      name2 = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, nameEnd));
    } catch {
      throw invalid2();
    }
    at = nameEnd;
    const normalized2 = sourcePathKey(name2);
    if (seen.has(normalized2)) throw new CloudRuleError(400, "source_archive_duplicate_path", name2);
    seen.add(normalized2);
    expanded += size;
    if (size > sourceArchiveLimit || expanded > sourceExpandedLimit) throw expansion();
    if (stored && compressed !== size) throw invalid2();
    if (local + 30 > cdOffset || u32(bytes, local) !== 67324752 || u162(bytes, local + 28)) throw invalid2();
    const start = local + 30 + u162(bytes, local + 26);
    if (start + compressed > cdOffset) throw invalid2();
    entries.push({ name: name2, size, stored, local, record, recordEnd: at, data: bytes.subarray(start, start + compressed) });
  }
  if (at !== end) throw invalid2();
  return entries;
}
function sourceManifestMismatch(files, sources) {
  const ids = new Set(sources.map((source) => source.sourceId));
  if (Object.keys(files).some((path) => manifestPath(path) && !ids.has(path))) return true;
  return sources.some((source) => !files[source.sourceId] || !equalBytes(files[source.sourceId], strToU8(source.text)));
}
function inspectSourceArchive(bytes, sources) {
  if (bytes.byteLength > sourceArchiveLimit) throw new CloudRuleError(400, "source_archive_too_large");
  const entries = directory(bytes);
  if (entries.some((entry) => !entry.stored)) throw new CloudRuleError(400, "source_archive_noncanonical");
  const ids = new Set(sources.map((source) => source.sourceId)), manifests = /* @__PURE__ */ Object.create(null);
  let expanded = 0, offset = 0, canonical2 = true;
  for (const entry of entries) {
    if (ids.has(entry.name) || manifestPath(entry.name)) manifests[entry.name] = entry.data;
    expanded += entry.size;
  }
  if (sourceManifestMismatch(manifests, sources)) throw new CloudRuleError(409, "source_manifest_mismatch");
  entries.forEach((entry, index) => {
    if (index && byName(entries[index - 1].name, entry.name) >= 0) canonical2 = false;
    if (!canonical2 || entry.local !== offset) {
      canonical2 = false;
      return;
    }
    const name2 = encoder.encode(entry.name);
    const shape = { name: name2, utf8: name2.length !== entry.name.length, crc: crc32(entry.data), size: entry.size, offset };
    if (!equalBytes(header(shape, false), bytes.subarray(entry.local, entry.local + 30 + name2.length)) || !equalBytes(header(shape, true), bytes.subarray(entry.record, entry.recordEnd))) canonical2 = false;
    offset += 30 + name2.length + entry.size;
  });
  if (!canonical2 || u32(bytes, bytes.byteLength - 22 + 16) !== offset) throw new CloudRuleError(400, "source_archive_noncanonical");
  return { files: entries.map((entry) => entry.name).sort(), expandedBytes: expanded };
}

// src/backend-artifact.mjs
import { createHash as createHash2 } from "node:crypto";

// ../../node_modules/.pnpm/es-module-lexer@2.3.2/node_modules/es-module-lexer/dist/lexer.asm.js
var e;
var a;
var r;
var i2 = 2 << 19;
var s = 1 === new Uint8Array(new Uint16Array([1]).buffer)[0] ? function(e2, a2) {
  const r2 = e2.length;
  let i3 = 0;
  for (; i3 < r2; ) a2[i3] = e2.charCodeAt(i3++);
} : function(e2, a2) {
  const r2 = e2.length;
  let i3 = 0;
  for (; i3 < r2; ) {
    const r3 = e2.charCodeAt(i3);
    a2[i3++] = (255 & r3) << 8 | r3 >>> 8;
  }
};
var f = "xportportetaourceeferromsyncunctionlassvoyiedelecontininstantybreareturdebuggeawaithrwhileforifcatcfinallels";
var c;
var t;
var n;
function parse(k2, l2 = "@") {
  c = k2, t = l2;
  const u2 = 2 * c.length + (2 << 18);
  if (u2 > i2 || !e) {
    for (; u2 > i2; ) i2 *= 2;
    a = new ArrayBuffer(i2), s(f, new Uint16Array(a, 16, 108)), e = (function(e2, a2, r2) {
      ;
      var i3 = new e2.Int8Array(r2), s2 = new e2.Int16Array(r2), f2 = new e2.Int32Array(r2), c2 = new e2.Uint8Array(r2), t2 = new e2.Uint16Array(r2), n2 = 1040;
      function b3() {
        var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, b5 = 0, k4 = 0, o3 = 0, h3 = 0;
        h3 = n2;
        n2 = n2 + 10240 | 0;
        i3[808] = 1;
        i3[807] = 0;
        s2[401] = 0;
        s2[402] = 0;
        f2[70] = f2[2];
        i3[809] = 0;
        f2[68] = 0;
        i3[806] = 0;
        f2[71] = h3 + 2048;
        f2[72] = h3;
        i3[810] = 0;
        e3 = (f2[3] | 0) + -2 | 0;
        f2[73] = e3;
        a3 = e3 + (f2[66] << 1) | 0;
        f2[74] = a3;
        e: while (1) {
          r3 = e3 + 2 | 0;
          f2[73] = r3;
          if (e3 >>> 0 >= a3 >>> 0) {
            c3 = 19;
            break;
          }
          a: do {
            switch (s2[r3 >> 1] | 0) {
              case 9:
              case 10:
              case 11:
              case 12:
              case 13:
              case 32:
                break;
              case 101: {
                if ((((s2[402] | 0) == 0 ? R(r3) | 0 : 0) ? (S(e3 + 4 | 0, 16, 10) | 0) == 0 : 0) ? (u3(), (i3[808] | 0) == 0) : 0) {
                  c3 = 9;
                  break e;
                } else c3 = 18;
                break;
              }
              case 105: {
                if (((s2[e3 + 4 >> 1] | 0) == 109 ? R(r3) | 0 : 0) ? (S(e3 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                  l3();
                  c3 = 18;
                } else c3 = 18;
                break;
              }
              case 59: {
                c3 = 18;
                break;
              }
              case 47:
                switch (s2[e3 + 4 >> 1] | 0) {
                  case 47: {
                    F();
                    break a;
                  }
                  case 42: {
                    x2(1);
                    break a;
                  }
                  default: {
                    c3 = 17;
                    break e;
                  }
                }
              default: {
                c3 = 17;
                break e;
              }
            }
          } while (0);
          if ((c3 | 0) == 18) {
            c3 = 0;
            f2[70] = f2[73];
          }
          e3 = f2[73] | 0;
          a3 = f2[74] | 0;
        }
        if ((c3 | 0) == 9) {
          e3 = f2[73] | 0;
          f2[70] = e3;
          c3 = 20;
        } else if ((c3 | 0) == 17) {
          i3[808] = 0;
          f2[73] = e3;
          c3 = 20;
        } else if ((c3 | 0) == 19) if (!(i3[806] | 0)) {
          e3 = r3;
          c3 = 20;
        } else e3 = 0;
        do {
          if ((c3 | 0) == 20) {
            r3 = e3;
            e: while (1) {
              e3 = r3 + 2 | 0;
              f2[73] = e3;
              if (r3 >>> 0 >= (f2[74] | 0) >>> 0) {
                c3 = 108;
                break;
              }
              a3 = s2[e3 >> 1] | 0;
              a: do {
                switch (a3 << 16 >> 16) {
                  case 9:
                  case 10:
                  case 11:
                  case 12:
                  case 13:
                  case 32:
                    break;
                  case 101: {
                    if (((s2[402] | 0) == 0 ? R(e3) | 0 : 0) ? (S(r3 + 4 | 0, 16, 10) | 0) == 0 : 0) {
                      u3();
                      c3 = 107;
                    } else c3 = 104;
                    break;
                  }
                  case 105: {
                    if (((s2[r3 + 4 >> 1] | 0) == 109 ? R(e3) | 0 : 0) ? (S(r3 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                      l3();
                      c3 = 107;
                    } else c3 = 104;
                    break;
                  }
                  case 99: {
                    if ((((s2[r3 + 4 >> 1] | 0) == 108 ? R(e3) | 0 : 0) ? (S(r3 + 6 | 0, 88, 6) | 0) == 0 : 0) ? L(s2[r3 + 12 >> 1] | 0) | 0 : 0) {
                      i3[810] = 1;
                      c3 = 104;
                    } else c3 = 104;
                    break;
                  }
                  case 40: {
                    r3 = f2[71] | 0;
                    c3 = s2[402] | 0;
                    f2[r3 + ((c3 & 65535) << 3) >> 2] = 1;
                    a3 = f2[70] | 0;
                    s2[402] = c3 + 1 << 16 >> 16;
                    f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = a3;
                    c3 = 107;
                    break;
                  }
                  case 91: {
                    r3 = f2[71] | 0;
                    c3 = s2[402] | 0;
                    f2[r3 + ((c3 & 65535) << 3) >> 2] = 8;
                    a3 = f2[70] | 0;
                    s2[402] = c3 + 1 << 16 >> 16;
                    f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = a3;
                    c3 = 107;
                    break;
                  }
                  case 93: {
                    e3 = s2[402] | 0;
                    if (!(e3 << 16 >> 16)) {
                      c3 = 40;
                      break e;
                    }
                    s2[402] = e3 + -1 << 16 >> 16;
                    c3 = 107;
                    break;
                  }
                  case 44: {
                    e3 = s2[401] | 0;
                    if (((e3 << 16 >> 16 != 0 ? (t3 = s2[402] | 0, t3 << 16 >> 16 != 0) : 0) ? (f2[(f2[71] | 0) + ((t3 & 65535) + -1 << 3) >> 2] | 0) == 5 : 0) ? (b5 = f2[(f2[72] | 0) + ((e3 & 65535) + -1 << 2) >> 2] | 0, (f2[b5 + 4 >> 2] | 0) == 0) : 0) {
                      f2[b5 + 4 >> 2] = (f2[70] | 0) + 2;
                      f2[73] = r3 + 4;
                      v2(1) | 0;
                      c3 = f2[73] | 0;
                      f2[b5 + 16 >> 2] = c3;
                      f2[73] = c3 + -2;
                      c3 = 107;
                    } else c3 = 107;
                    break;
                  }
                  case 41: {
                    e3 = s2[402] | 0;
                    if (!(e3 << 16 >> 16)) {
                      c3 = 48;
                      break e;
                    }
                    s2[402] = e3 + -1 << 16 >> 16;
                    a3 = s2[401] | 0;
                    if (a3 << 16 >> 16 != 0 ? (f2[(f2[71] | 0) + ((e3 + -1 & 65535) << 3) >> 2] | 0) == 5 : 0) {
                      e3 = f2[(f2[72] | 0) + ((a3 & 65535) + -1 << 2) >> 2] | 0;
                      if (!(f2[e3 + 4 >> 2] | 0)) f2[e3 + 4 >> 2] = (f2[70] | 0) + 2;
                      f2[e3 + 12 >> 2] = r3 + 4;
                      s2[401] = a3 + -1 << 16 >> 16;
                      c3 = 107;
                    } else c3 = 107;
                    break;
                  }
                  case 123: {
                    e3 = f2[70] | 0;
                    c3 = f2[62] | 0;
                    do {
                      if ((s2[e3 >> 1] | 0) == 41 & (c3 | 0) != 0 ? (f2[c3 + 12 >> 2] | 0) == (e3 + 2 | 0) : 0) {
                        a3 = f2[63] | 0;
                        f2[62] = a3;
                        if (!a3) {
                          f2[58] = 0;
                          break;
                        } else {
                          f2[a3 + 36 >> 2] = 0;
                          break;
                        }
                      }
                    } while (0);
                    r3 = f2[71] | 0;
                    c3 = s2[402] | 0;
                    f2[r3 + ((c3 & 65535) << 3) >> 2] = (i3[810] | 0) == 0 ? 2 : 6;
                    s2[402] = c3 + 1 << 16 >> 16;
                    f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = e3;
                    i3[810] = 0;
                    c3 = 107;
                    break;
                  }
                  case 125: {
                    e3 = s2[402] | 0;
                    if (!(e3 << 16 >> 16)) {
                      c3 = 61;
                      break e;
                    }
                    c3 = f2[71] | 0;
                    s2[402] = e3 + -1 << 16 >> 16;
                    if ((f2[c3 + ((e3 + -1 & 65535) << 3) >> 2] | 0) == 4) {
                      d2();
                      c3 = 107;
                    } else c3 = 107;
                    break;
                  }
                  case 34:
                  case 39: {
                    C(a3);
                    c3 = 107;
                    break;
                  }
                  case 47:
                    switch (s2[r3 + 4 >> 1] | 0) {
                      case 47: {
                        F();
                        break a;
                      }
                      case 42: {
                        x2(1);
                        break a;
                      }
                      default: {
                        e3 = f2[70] | 0;
                        a3 = s2[e3 >> 1] | 0;
                        r: do {
                          if (!($(a3) | 0)) if (a3 << 16 >> 16 == 41) {
                            r3 = s2[402] | 0;
                            if (!(K(f2[(f2[71] | 0) + ((r3 & 65535) << 3) + 4 >> 2] | 0) | 0)) c3 = 76;
                          } else c3 = 75;
                          else switch (a3 << 16 >> 16) {
                            case 46:
                              if (((s2[e3 + -2 >> 1] | 0) + -48 & 65535) < 10) {
                                c3 = 75;
                                break r;
                              } else break r;
                            case 43:
                              if ((s2[e3 + -2 >> 1] | 0) == 43) {
                                c3 = 75;
                                break r;
                              } else break r;
                            case 45:
                              if ((s2[e3 + -2 >> 1] | 0) == 45) {
                                c3 = 75;
                                break r;
                              } else break r;
                            default:
                              break r;
                          }
                        } while (0);
                        if ((c3 | 0) == 75) {
                          r3 = s2[402] | 0;
                          c3 = 76;
                        }
                        r: do {
                          if ((c3 | 0) == 76) {
                            c3 = 0;
                            if (r3 << 16 >> 16 != 0 ? (k4 = f2[71] | 0, o3 = (r3 & 65535) + -1 | 0, a3 << 16 >> 16 == 102 ? (f2[k4 + (o3 << 3) >> 2] | 0) == 1 : 0) : 0) {
                              if (((s2[e3 + -2 >> 1] | 0) == 111 ? g(e3 + -4 | 0) | 0 : 0) ? E(f2[k4 + (o3 << 3) + 4 >> 2] | 0, 196, 3) | 0 : 0) break;
                            } else c3 = 81;
                            if ((c3 | 0) == 81 ? (0, a3 << 16 >> 16 == 125) : 0) {
                              c3 = f2[71] | 0;
                              r3 = r3 & 65535;
                              if (U(f2[c3 + (r3 << 3) + 4 >> 2] | 0) | 0) break;
                              if ((f2[c3 + (r3 << 3) >> 2] | 0) == 6) break;
                            }
                            if (!(w2(e3) | 0)) {
                              switch (a3 << 16 >> 16) {
                                case 0:
                                  break r;
                                case 47: {
                                  if (i3[809] | 0) break r;
                                  break;
                                }
                                default: {
                                }
                              }
                              c3 = f2[64] | 0;
                              if ((c3 | 0 ? e3 >>> 0 >= (f2[c3 >> 2] | 0) >>> 0 : 0) ? e3 >>> 0 <= (f2[c3 + 4 >> 2] | 0) >>> 0 : 0) {
                                I();
                                i3[809] = 0;
                                c3 = 107;
                                break a;
                              }
                              r3 = f2[3] | 0;
                              do {
                                if (e3 >>> 0 <= r3 >>> 0) break;
                                e3 = e3 + -2 | 0;
                                f2[70] = e3;
                                a3 = s2[e3 >> 1] | 0;
                              } while (!(D(a3) | 0));
                              if (M(a3) | 0) {
                                do {
                                  if (e3 >>> 0 <= r3 >>> 0) break;
                                  e3 = e3 + -2 | 0;
                                  f2[70] = e3;
                                } while (M(s2[e3 >> 1] | 0) | 0);
                                if (q(e3) | 0) {
                                  I();
                                  i3[809] = 0;
                                  c3 = 107;
                                  break a;
                                }
                              }
                              i3[809] = 1;
                              c3 = 107;
                              break a;
                            }
                          }
                        } while (0);
                        I();
                        i3[809] = 0;
                        c3 = 107;
                        break a;
                      }
                    }
                  case 96: {
                    r3 = f2[71] | 0;
                    c3 = s2[402] | 0;
                    f2[r3 + ((c3 & 65535) << 3) + 4 >> 2] = f2[70];
                    s2[402] = c3 + 1 << 16 >> 16;
                    f2[r3 + ((c3 & 65535) << 3) >> 2] = 3;
                    d2();
                    c3 = 107;
                    break;
                  }
                  default:
                    if ((a3 & 65535) > 127 & a3 << 16 >> 16 != 160 | (a3 << 16 >> 16 == 92 | (a3 << 16 >> 16 == 95 | (a3 << 16 >> 16 == 36 | ((a3 + -48 & 65535) < 10 | ((a3 | 32) + -97 & 65535) < 26))))) c3 = 104;
                    else c3 = 107;
                }
              } while (0);
              a: do {
                if ((c3 | 0) == 104) while (1) {
                  e3 = e3 + 2 | 0;
                  c3 = s2[e3 >> 1] | 0;
                  if (!((c3 & 65535) > 127 & c3 << 16 >> 16 != 160 | (c3 << 16 >> 16 == 92 | (c3 << 16 >> 16 == 95 | (c3 << 16 >> 16 == 36 | ((c3 + -48 & 65535) < 10 | ((c3 | 32) + -97 & 65535) < 26)))))) {
                    c3 = 107;
                    break a;
                  }
                  f2[73] = e3;
                }
              } while (0);
              if ((c3 | 0) == 107) {
                c3 = 0;
                f2[70] = f2[73];
              }
              r3 = f2[73] | 0;
            }
            if ((c3 | 0) == 40) {
              ae();
              e3 = 0;
              break;
            } else if ((c3 | 0) == 48) {
              ae();
              e3 = 0;
              break;
            } else if ((c3 | 0) == 61) {
              ae();
              e3 = 0;
              break;
            } else if ((c3 | 0) == 108) {
              e3 = (i3[806] | 0) == 0 ? (s2[401] | s2[402]) << 16 >> 16 == 0 : 0;
              break;
            }
          }
        } while (0);
        n2 = h3;
        return e3 | 0;
      }
      function k3(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0, b5 = 0, k4 = 0, o3 = 0, h3 = 0, A2 = 0, p2 = 0, y2 = 0, m2 = 0, O2 = 0, T2 = 0;
        y2 = s2[402] | 0;
        a3 = f2[73] | 0;
        f2[70] = a3;
        k4 = a3;
        p2 = a3;
        o3 = y2;
        A2 = 0;
        e: while (1) {
          c3 = f2[74] | 0;
          n3 = o3 << 16 >> 16 == y2 << 16 >> 16;
          t3 = A2 & e3;
          b5 = a3;
          while (1) {
            r3 = b5 + 2 | 0;
            if (b5 >>> 0 >= c3 >>> 0) {
              a3 = 0;
              h3 = 104;
              break e;
            }
            a3 = s2[r3 >> 1] | 0;
            if (!(M(a3) | 0)) {
              if (n3) {
                switch (a3 << 16 >> 16) {
                  case 125:
                  case 93:
                  case 41:
                  case 59:
                  case 44: {
                    h3 = 104;
                    break e;
                  }
                  default: {
                  }
                }
                if (t3 ? be(a3) | 0 : 0) {
                  h3 = 104;
                  break e;
                }
              }
              if (!(be(a3) | 0)) break;
            }
            b5 = r3;
          }
          f2[73] = r3;
          a: do {
            switch (a3 << 16 >> 16) {
              case 101: {
                if ((o3 << 16 >> 16 == 0 ? R(r3) | 0 : 0) ? (S(b5 + 4 | 0, 16, 10) | 0) == 0 : 0) {
                  u3();
                  h3 = 93;
                } else h3 = 90;
                break;
              }
              case 105: {
                if (((s2[b5 + 4 >> 1] | 0) == 109 ? R(r3) | 0 : 0) ? (S(b5 + 6 | 0, 26, 8) | 0) == 0 : 0) {
                  l3();
                  h3 = 93;
                } else h3 = 90;
                break;
              }
              case 99: {
                if ((((s2[b5 + 4 >> 1] | 0) == 108 ? R(r3) | 0 : 0) ? (S(b5 + 6 | 0, 88, 6) | 0) == 0 : 0) ? L(s2[b5 + 12 >> 1] | 0) | 0 : 0) {
                  i3[810] = 1;
                  h3 = 90;
                } else h3 = 90;
                break;
              }
              case 40: {
                b5 = f2[71] | 0;
                h3 = o3 & 65535;
                f2[b5 + (h3 << 3) >> 2] = 1;
                s2[402] = o3 + 1 << 16 >> 16;
                f2[b5 + (h3 << 3) + 4 >> 2] = k4;
                h3 = 93;
                break;
              }
              case 91: {
                b5 = f2[71] | 0;
                h3 = o3 & 65535;
                f2[b5 + (h3 << 3) >> 2] = 8;
                s2[402] = o3 + 1 << 16 >> 16;
                f2[b5 + (h3 << 3) + 4 >> 2] = k4;
                h3 = 93;
                break;
              }
              case 93:
                if (!(o3 << 16 >> 16)) {
                  ae();
                  break a;
                } else {
                  s2[402] = o3 + -1 << 16 >> 16;
                  h3 = 93;
                  break a;
                }
              case 44: {
                r3 = s2[401] | 0;
                if ((!(o3 << 16 >> 16 == 0 | r3 << 16 >> 16 == 0) ? (f2[(f2[71] | 0) + ((o3 & 65535) + -1 << 3) >> 2] | 0) == 5 : 0) ? (m2 = f2[(f2[72] | 0) + ((r3 & 65535) + -1 << 2) >> 2] | 0, (f2[m2 + 4 >> 2] | 0) == 0) : 0) {
                  f2[m2 + 4 >> 2] = p2 + 2;
                  f2[73] = b5 + 4;
                  v2(1) | 0;
                  h3 = f2[73] | 0;
                  f2[m2 + 16 >> 2] = h3;
                  f2[73] = h3 + -2;
                  h3 = 93;
                } else h3 = 93;
                break;
              }
              case 41: {
                if (!(o3 << 16 >> 16)) {
                  ae();
                  break a;
                }
                h3 = o3 + -1 << 16 >> 16;
                s2[402] = h3;
                r3 = s2[401] | 0;
                if (r3 << 16 >> 16 != 0 ? (f2[(f2[71] | 0) + ((h3 & 65535) << 3) >> 2] | 0) == 5 : 0) {
                  c3 = f2[(f2[72] | 0) + ((r3 & 65535) + -1 << 2) >> 2] | 0;
                  if (!(f2[c3 + 4 >> 2] | 0)) f2[c3 + 4 >> 2] = p2 + 2;
                  f2[c3 + 12 >> 2] = b5 + 4;
                  s2[401] = r3 + -1 << 16 >> 16;
                  h3 = 93;
                } else h3 = 93;
                break;
              }
              case 123: {
                h3 = f2[62] | 0;
                do {
                  if ((s2[p2 >> 1] | 0) == 41 & (h3 | 0) != 0 ? (f2[h3 + 12 >> 2] | 0) == (p2 + 2 | 0) : 0) {
                    r3 = f2[63] | 0;
                    f2[62] = r3;
                    if (!r3) {
                      f2[58] = 0;
                      break;
                    } else {
                      f2[r3 + 36 >> 2] = 0;
                      break;
                    }
                  }
                } while (0);
                b5 = f2[71] | 0;
                h3 = o3 & 65535;
                f2[b5 + (h3 << 3) >> 2] = (i3[810] | 0) == 0 ? 2 : 6;
                s2[402] = o3 + 1 << 16 >> 16;
                f2[b5 + (h3 << 3) + 4 >> 2] = k4;
                i3[810] = 0;
                h3 = 93;
                break;
              }
              case 125: {
                if (!(o3 << 16 >> 16)) {
                  ae();
                  break a;
                }
                k4 = f2[71] | 0;
                h3 = o3 + -1 << 16 >> 16;
                s2[402] = h3;
                if ((f2[k4 + ((h3 & 65535) << 3) >> 2] | 0) == 4) {
                  d2();
                  h3 = 93;
                } else h3 = 93;
                break;
              }
              case 34:
              case 39: {
                C(a3);
                h3 = 93;
                break;
              }
              case 47:
                switch (s2[b5 + 4 >> 1] | 0) {
                  case 47: {
                    F();
                    break a;
                  }
                  case 42: {
                    x2(1);
                    break a;
                  }
                  default: {
                    c3 = s2[p2 >> 1] | 0;
                    r: do {
                      if (!($(c3) | 0)) {
                        if (!(c3 << 16 >> 16 == 41 ? K(f2[(f2[71] | 0) + ((o3 & 65535) << 3) + 4 >> 2] | 0) | 0 : 0)) h3 = 62;
                      } else switch (c3 << 16 >> 16) {
                        case 46:
                          if (((s2[p2 + -2 >> 1] | 0) + -48 & 65535) < 10) {
                            h3 = 62;
                            break r;
                          } else break r;
                        case 43:
                          if ((s2[p2 + -2 >> 1] | 0) == 43) {
                            h3 = 62;
                            break r;
                          } else break r;
                        case 45:
                          if ((s2[p2 + -2 >> 1] | 0) == 45) {
                            h3 = 62;
                            break r;
                          } else break r;
                        default:
                          break r;
                      }
                    } while (0);
                    r: do {
                      if ((h3 | 0) == 62) {
                        h3 = 0;
                        if (o3 << 16 >> 16 != 0 ? (O2 = f2[71] | 0, T2 = (o3 & 65535) + -1 | 0, c3 << 16 >> 16 == 102 ? (f2[O2 + (T2 << 3) >> 2] | 0) == 1 : 0) : 0) {
                          if (((s2[p2 + -2 >> 1] | 0) == 111 ? g(p2 + -4 | 0) | 0 : 0) ? E(f2[O2 + (T2 << 3) + 4 >> 2] | 0, 196, 3) | 0 : 0) break;
                        } else h3 = 67;
                        if ((h3 | 0) == 67 ? (0, c3 << 16 >> 16 == 125) : 0) {
                          t3 = f2[71] | 0;
                          r3 = o3 & 65535;
                          if (U(f2[t3 + (r3 << 3) + 4 >> 2] | 0) | 0) break;
                          if ((f2[t3 + (r3 << 3) >> 2] | 0) == 6) break;
                        }
                        if (!(w2(p2) | 0)) {
                          switch (c3 << 16 >> 16) {
                            case 0:
                              break r;
                            case 47: {
                              if (i3[809] | 0) break r;
                              break;
                            }
                            default: {
                            }
                          }
                          h3 = f2[64] | 0;
                          if ((h3 | 0 ? p2 >>> 0 >= (f2[h3 >> 2] | 0) >>> 0 : 0) ? p2 >>> 0 <= (f2[h3 + 4 >> 2] | 0) >>> 0 : 0) {
                            I();
                            i3[809] = 0;
                            h3 = 93;
                            break a;
                          }
                          t3 = f2[3] | 0;
                          r3 = p2;
                          do {
                            if (r3 >>> 0 <= t3 >>> 0) break;
                            r3 = r3 + -2 | 0;
                            f2[70] = r3;
                            c3 = s2[r3 >> 1] | 0;
                          } while (!(D(c3) | 0));
                          if (M(c3) | 0) {
                            do {
                              if (r3 >>> 0 <= t3 >>> 0) break;
                              r3 = r3 + -2 | 0;
                              f2[70] = r3;
                            } while (M(s2[r3 >> 1] | 0) | 0);
                            if (q(r3) | 0) {
                              I();
                              i3[809] = 0;
                              h3 = 93;
                              break a;
                            }
                          }
                          i3[809] = 1;
                          h3 = 93;
                          break a;
                        }
                      }
                    } while (0);
                    I();
                    i3[809] = 0;
                    h3 = 93;
                    break a;
                  }
                }
              case 96: {
                b5 = f2[71] | 0;
                h3 = o3 & 65535;
                f2[b5 + (h3 << 3) + 4 >> 2] = k4;
                s2[402] = o3 + 1 << 16 >> 16;
                f2[b5 + (h3 << 3) >> 2] = 3;
                d2();
                h3 = 93;
                break;
              }
              default:
                if ((a3 & 65535) > 127 & a3 << 16 >> 16 != 160 | (a3 << 16 >> 16 == 92 | (a3 << 16 >> 16 == 95 | (a3 << 16 >> 16 == 36 | ((a3 + -48 & 65535) < 10 | ((a3 | 32) + -97 & 65535) < 26))))) h3 = 90;
                else h3 = 93;
            }
          } while (0);
          a: do {
            if ((h3 | 0) == 90) while (1) {
              r3 = r3 + 2 | 0;
              h3 = s2[r3 >> 1] | 0;
              if (!((h3 & 65535) > 127 & h3 << 16 >> 16 != 160 | (h3 << 16 >> 16 == 92 | (h3 << 16 >> 16 == 95 | (h3 << 16 >> 16 == 36 | ((h3 + -48 & 65535) < 10 | ((h3 | 32) + -97 & 65535) < 26)))))) {
                h3 = 93;
                break a;
              }
              f2[73] = r3;
            }
          } while (0);
          if ((h3 | 0) == 93) {
            h3 = 0;
            f2[70] = f2[73];
          }
          if (i3[806] | 0) {
            a3 = 0;
            break;
          }
          r3 = f2[70] | 0;
          a: do {
            if ((r3 | 0) == (p2 | 0)) if (A2 & ((s2[402] | 0) == y2 << 16 >> 16 & e3)) {
              a3 = s2[f2[73] >> 1] | 0;
              if (be(a3) | 0) break e;
              else a3 = 1;
            } else a3 = A2;
            else {
              if (a3 << 16 >> 16 == 47) {
                a3 = (i3[809] | 0) == 0;
                break;
              }
              if (G(a3) | 0) a3 = 1;
              else {
                switch (a3 << 16 >> 16) {
                  case 96:
                  case 34:
                  case 39:
                  case 41:
                  case 93:
                  case 125: {
                    a3 = 1;
                    break a;
                  }
                  default: {
                  }
                }
                a3 = 0;
              }
            }
          } while (0);
          k4 = r3;
          p2 = r3;
          o3 = s2[402] | 0;
          A2 = a3;
          a3 = f2[73] | 0;
        }
        if ((h3 | 0) == 104) f2[73] = r3;
        return a3 | 0;
      }
      function l3() {
        var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0;
        n3 = f2[73] | 0;
        f2[73] = n3 + 12;
        e3 = v2(1) | 0;
        r3 = f2[73] | 0;
        e: do {
          if (e3 << 16 >> 16 != 46) {
            if (!(e3 << 16 >> 16 == 115 & r3 >>> 0 > (n3 + 12 | 0) >>> 0)) {
              if (!(e3 << 16 >> 16 == 100 & r3 >>> 0 > (n3 + 10 | 0) >>> 0)) {
                r3 = 0;
                t3 = 28;
                break;
              }
              if (S(r3 + 2 | 0, 50, 8) | 0) {
                a3 = r3;
                e3 = 100;
                r3 = 0;
                t3 = 60;
                break;
              }
              if (!(L(s2[r3 + 10 >> 1] | 0) | 0)) {
                a3 = r3;
                e3 = 100;
                r3 = 0;
                t3 = 60;
                break;
              }
              f2[73] = r3 + 10;
              e3 = v2(1) | 0;
              if (e3 << 16 >> 16 == 42) {
                e3 = 42;
                c3 = 2;
                t3 = 62;
                break;
              }
              f2[73] = r3;
              r3 = 0;
              t3 = 28;
              break;
            }
            if ((S(r3 + 2 | 0, 40, 10) | 0) == 0 ? L(s2[r3 + 12 >> 1] | 0) | 0 : 0) {
              f2[73] = r3 + 12;
              e3 = v2(1) | 0;
              a3 = f2[73] | 0;
              if ((a3 | 0) != (r3 + 12 | 0)) {
                if (e3 << 16 >> 16 != 102) {
                  r3 = 1;
                  t3 = 28;
                  break;
                }
                if (S(a3 + 2 | 0, 58, 6) | 0) {
                  e3 = 102;
                  r3 = 1;
                  t3 = 60;
                  break;
                }
                if (!(D(s2[a3 + 8 >> 1] | 0) | 0)) {
                  e3 = 102;
                  r3 = 1;
                  t3 = 60;
                  break;
                }
              }
              f2[73] = r3;
              r3 = 0;
              t3 = 28;
            } else {
              a3 = r3;
              e3 = 115;
              r3 = 0;
              t3 = 60;
            }
          } else {
            f2[73] = r3 + 2;
            switch ((v2(1) | 0) << 16 >> 16) {
              case 109: {
                e3 = f2[73] | 0;
                if (S(e3 + 2 | 0, 34, 6) | 0) break e;
                a3 = f2[70] | 0;
                if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                A(n3, n3, e3 + 8 | 0, 2);
                break e;
              }
              case 115: {
                e3 = f2[73] | 0;
                if (S(e3 + 2 | 0, 40, 10) | 0) break e;
                a3 = f2[70] | 0;
                if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                f2[73] = e3 + 12;
                e3 = v2(1) | 0;
                r3 = 1;
                t3 = 28;
                break e;
              }
              case 100: {
                e3 = f2[73] | 0;
                if (S(e3 + 2 | 0, 50, 8) | 0) break e;
                a3 = f2[70] | 0;
                if (!(N(a3) | 0) ? (s2[a3 >> 1] | 0) == 46 : 0) break e;
                f2[73] = e3 + 10;
                e3 = v2(1) | 0;
                r3 = 2;
                t3 = 28;
                break e;
              }
              default:
                break e;
            }
          }
        } while (0);
        e: do {
          if ((t3 | 0) == 28) {
            if (e3 << 16 >> 16 == 40) {
              a3 = f2[71] | 0;
              c3 = s2[402] | 0;
              f2[a3 + ((c3 & 65535) << 3) >> 2] = 5;
              e3 = f2[73] | 0;
              s2[402] = c3 + 1 << 16 >> 16;
              f2[a3 + ((c3 & 65535) << 3) + 4 >> 2] = e3;
              if ((s2[f2[70] >> 1] | 0) == 46) break;
              f2[73] = e3 + 2;
              a3 = v2(1) | 0;
              A(n3, f2[73] | 0, 0, e3);
              if (!r3) e3 = f2[62] | 0;
              else {
                e3 = f2[62] | 0;
                f2[e3 + 28 >> 2] = (r3 | 0) == 1 ? 5 : 7;
              }
              c3 = f2[72] | 0;
              n3 = s2[401] | 0;
              s2[401] = n3 + 1 << 16 >> 16;
              f2[c3 + ((n3 & 65535) << 2) >> 2] = e3;
              switch (a3 << 16 >> 16) {
                case 39: {
                  C(39);
                  break;
                }
                case 34: {
                  C(34);
                  break;
                }
                case 96: {
                  if (!(y() | 0)) t3 = 37;
                  break;
                }
                default:
                  t3 = 37;
              }
              if ((t3 | 0) == 37) {
                f2[73] = (f2[73] | 0) + -2;
                break;
              }
              e3 = (f2[73] | 0) + 2 | 0;
              f2[73] = e3;
              switch ((v2(1) | 0) << 16 >> 16) {
                case 44: {
                  f2[73] = (f2[73] | 0) + 2;
                  v2(1) | 0;
                  c3 = f2[62] | 0;
                  f2[c3 + 4 >> 2] = e3;
                  n3 = f2[73] | 0;
                  f2[c3 + 16 >> 2] = n3;
                  i3[c3 + 24 >> 0] = 1;
                  f2[73] = n3 + -2;
                  break e;
                }
                case 41: {
                  s2[402] = (s2[402] | 0) + -1 << 16 >> 16;
                  n3 = f2[62] | 0;
                  f2[n3 + 4 >> 2] = e3;
                  f2[n3 + 12 >> 2] = (f2[73] | 0) + 2;
                  i3[n3 + 24 >> 0] = 1;
                  s2[401] = (s2[401] | 0) + -1 << 16 >> 16;
                  break e;
                }
                default: {
                  f2[73] = (f2[73] | 0) + -2;
                  break e;
                }
              }
            }
            if (!((r3 | 0) == 0 & e3 << 16 >> 16 == 123)) {
              switch (e3 << 16 >> 16) {
                case 42:
                case 39:
                case 34: {
                  c3 = r3;
                  t3 = 62;
                  break e;
                }
                default: {
                }
              }
              a3 = f2[73] | 0;
              t3 = 60;
              break;
            }
            e3 = f2[73] | 0;
            if (s2[402] | 0) {
              f2[73] = e3 + -2;
              break;
            }
            while (1) {
              if (e3 >>> 0 >= (f2[74] | 0) >>> 0) break;
              e3 = v2(1) | 0;
              if (!(re(e3) | 0)) {
                if (e3 << 16 >> 16 == 125) {
                  t3 = 50;
                  break;
                }
              } else C(e3);
              e3 = (f2[73] | 0) + 2 | 0;
              f2[73] = e3;
            }
            if ((t3 | 0) == 50) f2[73] = (f2[73] | 0) + 2;
            c3 = (v2(1) | 0) << 16 >> 16 == 102;
            e3 = f2[73] | 0;
            if (c3 ? S(e3 + 2 | 0, 58, 6) | 0 : 0) {
              ae();
              break;
            }
            f2[73] = e3 + 8;
            e3 = v2(1) | 0;
            if (re(e3) | 0) {
              o2(n3, e3, 0);
              break;
            } else {
              ae();
              break;
            }
          }
        } while (0);
        if ((t3 | 0) == 60) if ((a3 | 0) == (n3 + 12 | 0)) f2[73] = n3 + 10;
        else {
          c3 = r3;
          t3 = 62;
        }
        do {
          if ((t3 | 0) == 62) {
            if (!((e3 << 16 >> 16 == 42 | (c3 | 0) != 2) & (s2[402] | 0) == 0)) {
              f2[73] = (f2[73] | 0) + -2;
              break;
            }
            e3 = f2[74] | 0;
            a3 = f2[73] | 0;
            while (1) {
              if (a3 >>> 0 >= e3 >>> 0) {
                t3 = 69;
                break;
              }
              r3 = s2[a3 >> 1] | 0;
              if (re(r3) | 0) {
                t3 = 67;
                break;
              }
              t3 = a3 + 2 | 0;
              f2[73] = t3;
              a3 = t3;
            }
            if ((t3 | 0) == 67) {
              o2(n3, r3, c3);
              break;
            } else if ((t3 | 0) == 69) {
              ae();
              break;
            }
          }
        } while (0);
        return;
      }
      function u3() {
        var e3 = 0, a3 = 0, r3 = 0, c3 = 0, t3 = 0, n3 = 0, b5 = 0, l4 = 0, u4 = 0, h3 = 0;
        l4 = f2[73] | 0;
        u4 = f2[64] | 0;
        f2[73] = l4 + 12;
        a3 = v2(1) | 0;
        e3 = f2[73] | 0;
        if (!((e3 | 0) == (l4 + 12 | 0) ? !(O(a3) | 0) : 0)) h3 = 3;
        e: do {
          if ((h3 | 0) == 3) {
            f2[65] = l4;
            a: do {
              switch (a3 << 16 >> 16) {
                case 123: {
                  f2[73] = e3 + 2;
                  e3 = v2(1) | 0;
                  a3 = f2[73] | 0;
                  while (1) {
                    if (re(e3) | 0) {
                      C(e3);
                      e3 = (f2[73] | 0) + 2 | 0;
                      f2[73] = e3;
                    } else {
                      H(e3) | 0;
                      e3 = f2[73] | 0;
                    }
                    v2(1) | 0;
                    e3 = p(a3, e3) | 0;
                    if (e3 << 16 >> 16 == 44) {
                      f2[73] = (f2[73] | 0) + 2;
                      e3 = v2(1) | 0;
                    }
                    if (e3 << 16 >> 16 == 125) {
                      h3 = 15;
                      break;
                    }
                    h3 = a3;
                    a3 = f2[73] | 0;
                    if ((a3 | 0) == (h3 | 0)) {
                      h3 = 12;
                      break;
                    }
                    if (a3 >>> 0 > (f2[74] | 0) >>> 0) {
                      h3 = 14;
                      break;
                    }
                  }
                  if ((h3 | 0) == 12) {
                    ae();
                    break e;
                  } else if ((h3 | 0) == 14) {
                    ae();
                    break e;
                  } else if ((h3 | 0) == 15) {
                    i3[807] = 1;
                    f2[73] = (f2[73] | 0) + 2;
                    break a;
                  }
                  break;
                }
                case 42: {
                  f2[73] = e3 + 2;
                  v2(1) | 0;
                  h3 = f2[73] | 0;
                  p(h3, h3) | 0;
                  break;
                }
                default: {
                  i3[808] = 0;
                  switch (a3 << 16 >> 16) {
                    case 100: {
                      f2[73] = e3 + 14;
                      switch ((v2(1) | 0) << 16 >> 16) {
                        case 97: {
                          a3 = f2[73] | 0;
                          if ((S(a3 + 2 | 0, 64, 8) | 0) == 0 ? M(s2[a3 + 10 >> 1] | 0) | 0 : 0) {
                            f2[73] = a3 + 10;
                            v2(0) | 0;
                            h3 = 22;
                          }
                          break;
                        }
                        case 102: {
                          h3 = 22;
                          break;
                        }
                        case 99: {
                          a3 = f2[73] | 0;
                          if (((S(a3 + 2 | 0, 86, 8) | 0) == 0 ? (u4 = s2[a3 + 10 >> 1] | 0, L(u4) | 0 | u4 << 16 >> 16 == 123) : 0) ? (f2[73] = a3 + 10, r3 = v2(1) | 0, r3 << 16 >> 16 != 123) : 0) {
                            b5 = r3;
                            h3 = 31;
                          }
                          break;
                        }
                        default: {
                        }
                      }
                      r: do {
                        if ((h3 | 0) == 22 ? (c3 = f2[73] | 0, (S(c3 + 2 | 0, 72, 14) | 0) == 0) : 0) {
                          a3 = s2[c3 + 16 >> 1] | 0;
                          if (!(L(a3) | 0)) switch (a3 << 16 >> 16) {
                            case 40:
                            case 42:
                              break;
                            default:
                              break r;
                          }
                          f2[73] = c3 + 16;
                          a3 = v2(1) | 0;
                          if (a3 << 16 >> 16 == 42) {
                            f2[73] = (f2[73] | 0) + 2;
                            a3 = v2(1) | 0;
                          }
                          if (a3 << 16 >> 16 != 40) {
                            b5 = a3;
                            h3 = 31;
                          }
                        }
                      } while (0);
                      if ((h3 | 0) == 31 ? (t3 = f2[73] | 0, H(b5) | 0, n3 = f2[73] | 0, n3 >>> 0 > t3 >>> 0) : 0) {
                        T(e3, e3 + 14 | 0, t3, n3);
                        f2[73] = (f2[73] | 0) + -2;
                        break e;
                      }
                      T(e3, e3 + 14 | 0, 0, 0);
                      f2[73] = e3 + 12;
                      break e;
                    }
                    case 97: {
                      f2[73] = e3 + 10;
                      v2(0) | 0;
                      e3 = f2[73] | 0;
                      h3 = 35;
                      break;
                    }
                    case 102: {
                      h3 = 35;
                      break;
                    }
                    case 99: {
                      if ((S(e3 + 2 | 0, 86, 8) | 0) == 0 ? D(s2[e3 + 10 >> 1] | 0) | 0 : 0) {
                        f2[73] = e3 + 10;
                        h3 = v2(1) | 0;
                        u4 = f2[73] | 0;
                        H(h3) | 0;
                        h3 = f2[73] | 0;
                        T(u4, h3, u4, h3);
                        f2[73] = (f2[73] | 0) + -2;
                        break e;
                      }
                      f2[73] = e3 + 4;
                      e3 = e3 + 4 | 0;
                      break;
                    }
                    case 108:
                    case 118:
                      break;
                    default:
                      break e;
                  }
                  if ((h3 | 0) == 35) {
                    f2[73] = e3 + 16;
                    e3 = v2(1) | 0;
                    if (e3 << 16 >> 16 == 42) {
                      f2[73] = (f2[73] | 0) + 2;
                      e3 = v2(1) | 0;
                    }
                    u4 = f2[73] | 0;
                    H(e3) | 0;
                    h3 = f2[73] | 0;
                    T(u4, h3, u4, h3);
                    f2[73] = (f2[73] | 0) + -2;
                    break e;
                  }
                  f2[73] = e3 + 6;
                  i3[808] = 0;
                  while (1) {
                    a3 = v2(1) | 0;
                    e3 = f2[73] | 0;
                    if (e3 >>> 0 > (f2[74] | 0) >>> 0) break;
                    a3 = P(a3) | 0;
                    if ((f2[73] | 0) == (e3 | 0)) break;
                    if (a3 << 16 >> 16 == 61) a3 = k3(1) | 0;
                    e3 = f2[73] | 0;
                    if (a3 << 16 >> 16 != 44) break;
                    f2[73] = e3 + 2;
                  }
                  f2[73] = e3 + -2;
                  break e;
                }
              }
            } while (0);
            h3 = (v2(1) | 0) << 16 >> 16 == 102;
            e3 = f2[73] | 0;
            if (h3 ? (S(e3 + 2 | 0, 58, 6) | 0) == 0 : 0) {
              f2[73] = e3 + 8;
              o2(l4, v2(1) | 0, 0);
              e3 = (u4 | 0) == 0 ? 236 : u4 + 20 | 0;
              while (1) {
                e3 = f2[e3 >> 2] | 0;
                if (!e3) break e;
                f2[e3 + 12 >> 2] = 0;
                f2[e3 + 8 >> 2] = 0;
                e3 = e3 + 20 | 0;
              }
            }
            f2[73] = e3 + -2;
          }
        } while (0);
        return;
      }
      function o2(e3, a3, r3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        r3 = r3 | 0;
        var i4 = 0, c3 = 0, t3 = 0, n3 = 0, b5 = 0;
        i4 = (f2[73] | 0) + 2 | 0;
        switch (a3 << 16 >> 16) {
          case 39: {
            C(39);
            c3 = 5;
            break;
          }
          case 34: {
            C(34);
            c3 = 5;
            break;
          }
          default:
            ae();
        }
        do {
          if ((c3 | 0) == 5) {
            A(e3, i4, f2[73] | 0, 1);
            if ((r3 | 0) > 0) f2[(f2[62] | 0) + 28 >> 2] = (r3 | 0) == 1 ? 4 : 6;
            f2[73] = (f2[73] | 0) + 2;
            n3 = (v2(0) | 0) << 16 >> 16 == 119;
            t3 = f2[73] | 0;
            if (((n3 ? (s2[t3 + 2 >> 1] | 0) == 105 : 0) ? (s2[t3 + 4 >> 1] | 0) == 116 : 0) ? (s2[t3 + 6 >> 1] | 0) == 104 : 0) {
              f2[73] = t3 + 8;
              if ((v2(1) | 0) << 16 >> 16 != 123) {
                f2[73] = t3;
                break;
              }
              n3 = f2[73] | 0;
              i4 = n3;
              c3 = 0;
              e: while (1) {
                f2[73] = i4 + 2;
                i4 = v2(1) | 0;
                do {
                  if (i4 << 16 >> 16 != 39) {
                    a3 = f2[73] | 0;
                    if (i4 << 16 >> 16 == 34) {
                      C(34);
                      e3 = (f2[73] | 0) + 2 | 0;
                      f2[73] = e3;
                      i4 = v2(1) | 0;
                      break;
                    } else {
                      i4 = H(i4) | 0;
                      e3 = f2[73] | 0;
                      break;
                    }
                  } else {
                    a3 = f2[73] | 0;
                    C(39);
                    e3 = (f2[73] | 0) + 2 | 0;
                    f2[73] = e3;
                    i4 = v2(1) | 0;
                  }
                } while (0);
                if (i4 << 16 >> 16 != 58) {
                  c3 = 21;
                  break;
                }
                f2[73] = (f2[73] | 0) + 2;
                switch ((v2(1) | 0) << 16 >> 16) {
                  case 39: {
                    i4 = f2[73] | 0;
                    C(39);
                    break;
                  }
                  case 34: {
                    i4 = f2[73] | 0;
                    C(34);
                    break;
                  }
                  default: {
                    c3 = 25;
                    break e;
                  }
                }
                b5 = (f2[73] | 0) + 2 | 0;
                r3 = f2[67] | 0;
                f2[67] = r3 + 20;
                f2[r3 >> 2] = a3;
                f2[r3 + 4 >> 2] = e3;
                f2[r3 + 8 >> 2] = i4;
                f2[r3 + 12 >> 2] = b5;
                f2[r3 + 16 >> 2] = 0;
                f2[((c3 | 0) == 0 ? (f2[62] | 0) + 32 | 0 : c3 + 16 | 0) >> 2] = r3;
                f2[73] = (f2[73] | 0) + 2;
                switch ((v2(1) | 0) << 16 >> 16) {
                  case 125: {
                    c3 = 29;
                    break e;
                  }
                  case 44:
                    break;
                  default: {
                    c3 = 27;
                    break e;
                  }
                }
                i4 = (f2[73] | 0) + 2 | 0;
                f2[73] = i4;
                c3 = r3;
              }
              if ((c3 | 0) == 21) {
                f2[73] = t3;
                break;
              } else if ((c3 | 0) == 25) {
                f2[73] = t3;
                break;
              } else if ((c3 | 0) == 27) {
                f2[73] = t3;
                break;
              } else if ((c3 | 0) == 29) {
                b5 = f2[62] | 0;
                f2[b5 + 16 >> 2] = n3;
                f2[b5 + 12 >> 2] = (f2[73] | 0) + 2;
                break;
              }
            }
            f2[73] = t3 + -2;
          }
        } while (0);
        return;
      }
      function h2() {
        var e3 = 0, a3 = 0, r3 = 0, i4 = 0, c3 = 0, t3 = 0, n3 = 0;
        e3 = f2[73] | 0;
        c3 = (s2[e3 >> 1] | 0) == 123;
        f2[73] = e3 + 2;
        e3 = v2(1) | 0;
        t3 = c3 ? 125 : 93;
        e: while (1) {
          if ((t3 | 0) == (e3 & 65535 | 0)) break;
          i4 = f2[73] | 0;
          if (i4 >>> 0 > (f2[74] | 0) >>> 0) break;
          if ((e3 << 16 >> 16 == 46 ? (s2[i4 + 2 >> 1] | 0) == 46 : 0) ? (s2[i4 + 4 >> 1] | 0) == 46 : 0) {
            f2[73] = i4 + 6;
            e3 = P(v2(1) | 0) | 0;
          } else n3 = 9;
          a: do {
            if ((n3 | 0) == 9) {
              n3 = 0;
              do {
                if (c3) {
                  do {
                    if (e3 << 16 >> 16 == 91) {
                      k3(0) | 0;
                      f2[73] = (f2[73] | 0) + 2;
                      a3 = i4;
                    } else {
                      if (re(e3) | 0) {
                        C(e3);
                        f2[73] = (f2[73] | 0) + 2;
                        a3 = i4;
                        break;
                      }
                      if ((e3 + -48 & 65535) >= 10) {
                        H(e3) | 0;
                        a3 = f2[73] | 0;
                        break;
                      }
                      e3 = i4;
                      r: while (1) {
                        r3 = e3 + 2 | 0;
                        a3 = s2[r3 >> 1] | 0;
                        i: do {
                          if ((a3 + -48 & 65535) >= 10) {
                            switch (a3 << 16 >> 16) {
                              case 67:
                              case 68:
                              case 70:
                              case 97:
                              case 65:
                              case 99:
                              case 100:
                              case 102:
                              case 46:
                              case 66:
                              case 69:
                              case 79:
                              case 88:
                              case 95:
                              case 98:
                              case 101:
                              case 110:
                              case 111:
                              case 120:
                                break i;
                              case 43:
                              case 45:
                                break;
                              default:
                                break r;
                            }
                            switch (s2[e3 >> 1] | 0) {
                              case 69:
                              case 101:
                                break;
                              default:
                                break r;
                            }
                          }
                        } while (0);
                        e3 = r3;
                      }
                      f2[73] = r3;
                      a3 = i4;
                    }
                  } while (0);
                  e3 = v2(1) | 0;
                  if (e3 << 16 >> 16 == 58) {
                    f2[73] = (f2[73] | 0) + 2;
                    e3 = P(v2(1) | 0) | 0;
                    break;
                  }
                  if (a3 >>> 0 > i4 >>> 0) T(i4, a3, i4, a3);
                } else if (e3 << 16 >> 16 == 44) {
                  f2[73] = i4 + 2;
                  e3 = v2(1) | 0;
                  break a;
                } else {
                  e3 = P(e3) | 0;
                  break;
                }
              } while (0);
              if (e3 << 16 >> 16 == 61) e3 = k3(0) | 0;
              if (e3 << 16 >> 16 != 44) break e;
              f2[73] = (f2[73] | 0) + 2;
              e3 = v2(1) | 0;
            }
          } while (0);
        }
        return;
      }
      function w2(e3) {
        e3 = e3 | 0;
        e: do {
          switch (s2[e3 >> 1] | 0) {
            case 100:
              switch (s2[e3 + -2 >> 1] | 0) {
                case 105: {
                  e3 = E(e3 + -4 | 0, 94, 2) | 0;
                  break e;
                }
                case 108: {
                  e3 = E(e3 + -4 | 0, 98, 3) | 0;
                  break e;
                }
                default: {
                  e3 = 0;
                  break e;
                }
              }
            case 101:
              switch (s2[e3 + -2 >> 1] | 0) {
                case 115:
                  switch (s2[e3 + -4 >> 1] | 0) {
                    case 108: {
                      e3 = z(e3 + -6 | 0, 101) | 0;
                      break e;
                    }
                    case 97: {
                      e3 = z(e3 + -6 | 0, 99) | 0;
                      break e;
                    }
                    default: {
                      e3 = 0;
                      break e;
                    }
                  }
                case 116: {
                  e3 = E(e3 + -4 | 0, 104, 4) | 0;
                  break e;
                }
                case 117: {
                  e3 = E(e3 + -4 | 0, 112, 6) | 0;
                  break e;
                }
                default: {
                  e3 = 0;
                  break e;
                }
              }
            case 102: {
              if ((s2[e3 + -2 >> 1] | 0) == 111 ? (s2[e3 + -4 >> 1] | 0) == 101 : 0) switch (s2[e3 + -6 >> 1] | 0) {
                case 99: {
                  e3 = E(e3 + -8 | 0, 124, 6) | 0;
                  break e;
                }
                case 112: {
                  e3 = E(e3 + -8 | 0, 136, 2) | 0;
                  break e;
                }
                default: {
                  e3 = 0;
                  break e;
                }
              }
              else e3 = 0;
              break;
            }
            case 107: {
              e3 = E(e3 + -2 | 0, 140, 4) | 0;
              break;
            }
            case 110: {
              if (z(e3 + -2 | 0, 105) | 0) e3 = 1;
              else e3 = E(e3 + -2 | 0, 148, 5) | 0;
              break;
            }
            case 111: {
              e3 = z(e3 + -2 | 0, 100) | 0;
              break;
            }
            case 114: {
              e3 = E(e3 + -2 | 0, 158, 7) | 0;
              break;
            }
            case 116: {
              e3 = E(e3 + -2 | 0, 172, 4) | 0;
              break;
            }
            case 119:
              switch (s2[e3 + -2 >> 1] | 0) {
                case 101: {
                  e3 = z(e3 + -4 | 0, 110) | 0;
                  break e;
                }
                case 111: {
                  e3 = E(e3 + -4 | 0, 180, 3) | 0;
                  break e;
                }
                default: {
                  e3 = 0;
                  break e;
                }
              }
            default:
              e3 = 0;
          }
        } while (0);
        return e3 | 0;
      }
      function d2() {
        var e3 = 0, a3 = 0, r3 = 0;
        a3 = f2[74] | 0;
        r3 = f2[73] | 0;
        e: while (1) {
          e3 = r3 + 2 | 0;
          if (r3 >>> 0 >= a3 >>> 0) {
            a3 = 10;
            break;
          }
          switch (s2[e3 >> 1] | 0) {
            case 96: {
              a3 = 7;
              break e;
            }
            case 36: {
              if ((s2[r3 + 4 >> 1] | 0) == 123) {
                a3 = 6;
                break e;
              }
              break;
            }
            case 92: {
              e3 = r3 + 4 | 0;
              break;
            }
            default: {
            }
          }
          r3 = e3;
        }
        if ((a3 | 0) == 6) {
          e3 = r3 + 4 | 0;
          f2[73] = e3;
          a3 = f2[71] | 0;
          r3 = s2[402] | 0;
          f2[a3 + ((r3 & 65535) << 3) >> 2] = 4;
          s2[402] = r3 + 1 << 16 >> 16;
          f2[a3 + ((r3 & 65535) << 3) + 4 >> 2] = e3;
        } else if ((a3 | 0) == 7) {
          f2[73] = e3;
          a3 = f2[71] | 0;
          r3 = (s2[402] | 0) + -1 << 16 >> 16;
          s2[402] = r3;
          if ((f2[a3 + ((r3 & 65535) << 3) >> 2] | 0) != 3) ae();
        } else if ((a3 | 0) == 10) {
          f2[73] = e3;
          ae();
        }
        return;
      }
      function v2(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0, i4 = 0;
        r3 = f2[73] | 0;
        e: do {
          a3 = s2[r3 >> 1] | 0;
          a: do {
            if (a3 << 16 >> 16 != 47) if (e3) if (L(a3) | 0) break;
            else break e;
            else if (M(a3) | 0) break;
            else break e;
            else switch (s2[r3 + 2 >> 1] | 0) {
              case 47: {
                F();
                break a;
              }
              case 42: {
                x2(e3);
                break a;
              }
              default: {
                a3 = 47;
                break e;
              }
            }
          } while (0);
          i4 = f2[73] | 0;
          r3 = i4 + 2 | 0;
          f2[73] = r3;
        } while (i4 >>> 0 < (f2[74] | 0) >>> 0);
        return a3 | 0;
      }
      function A(e3, a3, r3, s3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        r3 = r3 | 0;
        s3 = s3 | 0;
        var c3 = 0, t3 = 0;
        t3 = f2[67] | 0;
        f2[67] = t3 + 40;
        c3 = f2[62] | 0;
        f2[((c3 | 0) == 0 ? 232 : c3 + 36 | 0) >> 2] = t3;
        f2[63] = c3;
        f2[62] = t3;
        f2[t3 + 8 >> 2] = e3;
        if (2 == (s3 | 0)) {
          e3 = 3;
          c3 = r3;
        } else {
          e3 = 1 == (s3 | 0) ? 1 : 2;
          c3 = 1 == (s3 | 0) ? r3 + 2 | 0 : 0;
        }
        f2[t3 + 12 >> 2] = c3;
        f2[t3 + 28 >> 2] = e3;
        f2[t3 >> 2] = a3;
        f2[t3 + 4 >> 2] = r3;
        f2[t3 + 16 >> 2] = 0;
        f2[t3 + 20 >> 2] = s3;
        i3[t3 + 24 >> 0] = 1 == (s3 | 0) & 1;
        f2[t3 + 32 >> 2] = 0;
        f2[t3 + 36 >> 2] = 0;
        if (1 == (s3 | 0) | 2 == (s3 | 0)) i3[807] = 1;
        return;
      }
      function C(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0, i4 = 0, c3 = 0;
        c3 = f2[74] | 0;
        a3 = f2[73] | 0;
        while (1) {
          i4 = a3 + 2 | 0;
          if (a3 >>> 0 >= c3 >>> 0) {
            a3 = 9;
            break;
          }
          r3 = s2[i4 >> 1] | 0;
          if (r3 << 16 >> 16 == e3 << 16 >> 16) {
            a3 = 10;
            break;
          }
          if (r3 << 16 >> 16 == 92) {
            r3 = a3 + 4 | 0;
            if ((s2[r3 >> 1] | 0) == 13) {
              a3 = a3 + 6 | 0;
              a3 = (s2[a3 >> 1] | 0) == 10 ? a3 : r3;
            } else a3 = r3;
          } else if (be(r3) | 0) {
            a3 = 9;
            break;
          } else a3 = i4;
        }
        if ((a3 | 0) == 9) {
          f2[73] = i4;
          ae();
        } else if ((a3 | 0) == 10) f2[73] = i4;
        return;
      }
      function g(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0;
        a3 = s2[e3 >> 1] | 0;
        if (L(a3) | 0) r3 = 3;
        else switch (a3 << 16 >> 16) {
          case 41:
          case 125:
          case 93: {
            r3 = 3;
            break;
          }
          default:
            e3 = 0;
        }
        e: do {
          if ((r3 | 0) == 3) {
            r3 = f2[3] | 0;
            while (1) {
              if (e3 >>> 0 <= r3 >>> 0) break;
              e3 = e3 + -2 | 0;
              if (!(L(a3) | 0)) break;
              a3 = s2[e3 >> 1] | 0;
            }
            switch (a3 << 16 >> 16) {
              case 41:
              case 125:
              case 93: {
                e3 = 1;
                break e;
              }
              default: {
              }
            }
            e3 = (O(a3) | 0) ^ 1;
          }
        } while (0);
        return e3 | 0;
      }
      function p(e3, a3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        var r3 = 0, i4 = 0, c3 = 0, t3 = 0;
        r3 = f2[73] | 0;
        i4 = s2[r3 >> 1] | 0;
        c3 = (e3 | 0) == (a3 | 0) ? 0 : e3;
        t3 = (e3 | 0) == (a3 | 0) ? 0 : a3;
        if (i4 << 16 >> 16 == 97) {
          f2[73] = r3 + 4;
          r3 = v2(1) | 0;
          e3 = f2[73] | 0;
          if (re(r3) | 0) {
            C(r3);
            a3 = (f2[73] | 0) + 2 | 0;
            f2[73] = a3;
          } else {
            H(r3) | 0;
            a3 = f2[73] | 0;
          }
          i4 = v2(1) | 0;
          r3 = f2[73] | 0;
        }
        if ((r3 | 0) != (e3 | 0)) T(e3, a3, c3, t3);
        return i4 | 0;
      }
      function y() {
        var e3 = 0, a3 = 0, r3 = 0, i4 = 0;
        i4 = f2[73] | 0;
        r3 = f2[74] | 0;
        a3 = i4;
        e: while (1) {
          e3 = a3 + 2 | 0;
          if (a3 >>> 0 >= r3 >>> 0) {
            a3 = 7;
            break;
          }
          switch (s2[e3 >> 1] | 0) {
            case 96: {
              a3 = 8;
              break e;
            }
            case 92: {
              e3 = a3 + 4 | 0;
              break;
            }
            case 36: {
              if ((s2[a3 + 4 >> 1] | 0) == 123) {
                a3 = 7;
                break e;
              }
              break;
            }
            default: {
            }
          }
          a3 = e3;
        }
        if ((a3 | 0) == 7) {
          f2[73] = i4;
          e3 = 0;
        } else if ((a3 | 0) == 8) {
          f2[73] = e3;
          e3 = 1;
        }
        return e3 | 0;
      }
      function m() {
        var e3 = 0, a3 = 0, r3 = 0;
        r3 = f2[74] | 0;
        a3 = f2[73] | 0;
        e: while (1) {
          e3 = a3 + 2 | 0;
          if (a3 >>> 0 >= r3 >>> 0) {
            a3 = 6;
            break;
          }
          switch (s2[e3 >> 1] | 0) {
            case 13:
            case 10: {
              a3 = 6;
              break e;
            }
            case 93: {
              a3 = 7;
              break e;
            }
            case 92: {
              e3 = a3 + 4 | 0;
              break;
            }
            default: {
            }
          }
          a3 = e3;
        }
        if ((a3 | 0) == 6) {
          f2[73] = e3;
          ae();
          e3 = 0;
        } else if ((a3 | 0) == 7) {
          f2[73] = e3;
          e3 = 93;
        }
        return e3 | 0;
      }
      function I() {
        var e3 = 0, a3 = 0;
        e: while (1) {
          e3 = f2[73] | 0;
          f2[73] = e3 + 2;
          if (e3 >>> 0 >= (f2[74] | 0) >>> 0) {
            a3 = 7;
            break;
          }
          switch (s2[e3 + 2 >> 1] | 0) {
            case 13:
            case 10: {
              a3 = 7;
              break e;
            }
            case 47:
              break e;
            case 91: {
              m() | 0;
              break;
            }
            case 92: {
              f2[73] = e3 + 4;
              break;
            }
            default: {
            }
          }
        }
        if ((a3 | 0) == 7) ae();
        return;
      }
      function U(e3) {
        e3 = e3 | 0;
        switch (s2[e3 >> 1] | 0) {
          case 62: {
            e3 = (s2[e3 + -2 >> 1] | 0) == 61;
            break;
          }
          case 41:
          case 59: {
            e3 = 1;
            break;
          }
          case 104: {
            e3 = E(e3 + -2 | 0, 206, 4) | 0;
            break;
          }
          case 121: {
            e3 = E(e3 + -2 | 0, 214, 6) | 0;
            break;
          }
          case 101: {
            e3 = E(e3 + -2 | 0, 226, 3) | 0;
            break;
          }
          default:
            e3 = 0;
        }
        return e3 | 0;
      }
      function x2(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0, i4 = 0, c3 = 0, t3 = 0;
        c3 = (f2[73] | 0) + 2 | 0;
        f2[73] = c3;
        r3 = f2[74] | 0;
        while (1) {
          a3 = c3 + 2 | 0;
          if (c3 >>> 0 >= r3 >>> 0) break;
          i4 = s2[a3 >> 1] | 0;
          if (!e3 ? be(i4) | 0 : 0) break;
          if (i4 << 16 >> 16 == 42 ? (s2[c3 + 4 >> 1] | 0) == 47 : 0) {
            t3 = 8;
            break;
          }
          c3 = a3;
        }
        if ((t3 | 0) == 8) {
          f2[73] = a3;
          a3 = c3 + 4 | 0;
        }
        f2[73] = a3;
        return;
      }
      function S(e3, a3, r3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        r3 = r3 | 0;
        var s3 = 0, f3 = 0;
        e: do {
          if (!r3) e3 = 0;
          else {
            while (1) {
              s3 = i3[e3 >> 0] | 0;
              f3 = i3[a3 >> 0] | 0;
              if (s3 << 24 >> 24 != f3 << 24 >> 24) break;
              r3 = r3 + -1 | 0;
              if (!r3) {
                e3 = 0;
                break e;
              } else {
                e3 = e3 + 1 | 0;
                a3 = a3 + 1 | 0;
              }
            }
            e3 = (s3 & 255) - (f3 & 255) | 0;
          }
        } while (0);
        return e3 | 0;
      }
      function O(e3) {
        e3 = e3 | 0;
        e: do {
          switch (e3 << 16 >> 16) {
            case 38:
            case 37:
            case 33: {
              e3 = 1;
              break;
            }
            default:
              if ((e3 & -8) << 16 >> 16 == 40 | (e3 + -58 & 65535) < 6) e3 = 1;
              else {
                switch (e3 << 16 >> 16) {
                  case 91:
                  case 93:
                  case 94: {
                    e3 = 1;
                    break e;
                  }
                  default: {
                  }
                }
                e3 = (e3 + -123 & 65535) < 4;
              }
          }
        } while (0);
        return e3 | 0;
      }
      function $(e3) {
        e3 = e3 | 0;
        e: do {
          switch (e3 << 16 >> 16) {
            case 38:
            case 37:
            case 33:
              break;
            default:
              if (!((e3 + -58 & 65535) < 6 | (e3 + -40 & 65535) < 7 & e3 << 16 >> 16 != 41)) {
                switch (e3 << 16 >> 16) {
                  case 91:
                  case 94:
                    break e;
                  default: {
                  }
                }
                return e3 << 16 >> 16 != 125 & (e3 + -123 & 65535) < 4 | 0;
              }
          }
        } while (0);
        return 1;
      }
      function T(e3, a3, r3, s3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        r3 = r3 | 0;
        s3 = s3 | 0;
        var c3 = 0, t3 = 0;
        c3 = f2[67] | 0;
        f2[67] = c3 + 24;
        t3 = f2[64] | 0;
        f2[((t3 | 0) == 0 ? 236 : t3 + 20 | 0) >> 2] = c3;
        f2[64] = c3;
        f2[c3 >> 2] = e3;
        f2[c3 + 4 >> 2] = a3;
        f2[c3 + 8 >> 2] = r3;
        f2[c3 + 12 >> 2] = s3;
        f2[c3 + 16 >> 2] = f2[65];
        f2[c3 + 20 >> 2] = 0;
        i3[807] = 1;
        return;
      }
      function j(e3) {
        e3 = e3 | 0;
        var a3 = 0;
        a3 = s2[e3 >> 1] | 0;
        e: do {
          if ((a3 + -9 & 65535) >= 5) {
            switch (a3 << 16 >> 16) {
              case 160:
              case 32: {
                a3 = 1;
                break e;
              }
              default: {
              }
            }
            if (O(a3) | 0) return a3 << 16 >> 16 != 46 | (N(e3) | 0) | 0;
            else a3 = 0;
          } else a3 = 1;
        } while (0);
        return a3 | 0;
      }
      function B(e3) {
        e3 = e3 | 0;
        var a3 = 0, r3 = 0;
        r3 = n2;
        n2 = n2 + 16 | 0;
        f2[r3 >> 2] = 0;
        f2[66] = e3;
        a3 = f2[3] | 0;
        s2[a3 + (e3 << 1) >> 1] = 0;
        f2[r3 >> 2] = a3 + (e3 << 1) + 2;
        f2[67] = a3 + (e3 << 1) + 2;
        f2[58] = 0;
        f2[62] = 0;
        f2[60] = 0;
        f2[59] = 0;
        f2[64] = 0;
        f2[61] = 0;
        n2 = r3;
        return a3 | 0;
      }
      function E(e3, a3, r3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        r3 = r3 | 0;
        var i4 = 0, s3 = 0;
        s3 = e3 + (0 - r3 << 1) + 2 | 0;
        i4 = f2[3] | 0;
        if (s3 >>> 0 >= i4 >>> 0 ? (S(s3, a3, r3 << 1) | 0) == 0 : 0) if ((s3 | 0) == (i4 | 0)) i4 = 1;
        else i4 = j(e3 + (0 - r3 << 1) | 0) | 0;
        else i4 = 0;
        return i4 | 0;
      }
      function P(e3) {
        e3 = e3 | 0;
        var a3 = 0;
        switch (e3 << 16 >> 16) {
          case 91:
          case 123: {
            h2();
            f2[73] = (f2[73] | 0) + 2;
            break;
          }
          default: {
            a3 = f2[73] | 0;
            H(e3) | 0;
            e3 = f2[73] | 0;
            if (e3 >>> 0 > a3 >>> 0) T(a3, e3, a3, e3);
          }
        }
        return v2(1) | 0;
      }
      function q(e3) {
        e3 = e3 | 0;
        switch (s2[e3 >> 1] | 0) {
          case 107: {
            e3 = E(e3 + -2 | 0, 140, 4) | 0;
            break;
          }
          case 101: {
            if ((s2[e3 + -2 >> 1] | 0) == 117) e3 = E(e3 + -4 | 0, 112, 6) | 0;
            else e3 = 0;
            break;
          }
          default:
            e3 = 0;
        }
        return e3 | 0;
      }
      function z(e3, a3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        var r3 = 0;
        r3 = f2[3] | 0;
        if (r3 >>> 0 <= e3 >>> 0 ? (s2[e3 >> 1] | 0) == a3 << 16 >> 16 : 0) if ((r3 | 0) == (e3 | 0)) r3 = 1;
        else r3 = D(s2[e3 + -2 >> 1] | 0) | 0;
        else r3 = 0;
        return r3 | 0;
      }
      function D(e3) {
        e3 = e3 | 0;
        e: do {
          if ((e3 + -9 & 65535) < 5) e3 = 1;
          else {
            switch (e3 << 16 >> 16) {
              case 32:
              case 160: {
                e3 = 1;
                break e;
              }
              default: {
              }
            }
            e3 = e3 << 16 >> 16 != 46 & (O(e3) | 0);
          }
        } while (0);
        return e3 | 0;
      }
      function F() {
        var e3 = 0, a3 = 0, r3 = 0;
        e3 = f2[74] | 0;
        r3 = f2[73] | 0;
        e: while (1) {
          a3 = r3 + 2 | 0;
          if (r3 >>> 0 >= e3 >>> 0) break;
          switch (s2[a3 >> 1] | 0) {
            case 13:
            case 10:
              break e;
            default:
              r3 = a3;
          }
        }
        f2[73] = a3;
        return;
      }
      function G(e3) {
        e3 = e3 | 0;
        e: do {
          if (((e3 & -33) + -65 & 65535) < 26 | (e3 + -48 & 65535) < 10) e3 = 1;
          else {
            switch (e3 << 16 >> 16) {
              case 36:
              case 95: {
                e3 = 1;
                break e;
              }
              default: {
              }
            }
            e3 = (e3 & 65535) > 127;
          }
        } while (0);
        return e3 | 0;
      }
      function H(e3) {
        e3 = e3 | 0;
        while (1) {
          if (L(e3) | 0) break;
          if (O(e3) | 0) break;
          e3 = (f2[73] | 0) + 2 | 0;
          f2[73] = e3;
          e3 = s2[e3 >> 1] | 0;
          if (!(e3 << 16 >> 16)) {
            e3 = 0;
            break;
          }
        }
        return e3 | 0;
      }
      function J() {
        var e3 = 0;
        e3 = f2[(f2[60] | 0) + 20 >> 2] | 0;
        switch (e3 | 0) {
          case 1: {
            e3 = -1;
            break;
          }
          case 2: {
            e3 = -2;
            break;
          }
          default:
            e3 = e3 - (f2[3] | 0) >> 1;
        }
        return e3 | 0;
      }
      function K(e3) {
        e3 = e3 | 0;
        if (!(E(e3, 186, 5) | 0) ? !(E(e3, 196, 3) | 0) : 0) e3 = E(e3, 202, 2) | 0;
        else e3 = 1;
        return e3 | 0;
      }
      function L(e3) {
        e3 = e3 | 0;
        switch (e3 << 16 >> 16) {
          case 160:
          case 9:
          case 10:
          case 11:
          case 12:
          case 13:
          case 32: {
            e3 = 1;
            break;
          }
          default:
            e3 = 0;
        }
        return e3 | 0;
      }
      function M(e3) {
        e3 = e3 | 0;
        switch (e3 << 16 >> 16) {
          case 160:
          case 32:
          case 12:
          case 11:
          case 9: {
            e3 = 1;
            break;
          }
          default:
            e3 = 0;
        }
        return e3 | 0;
      }
      function N(e3) {
        e3 = e3 | 0;
        if ((s2[e3 >> 1] | 0) == 46 ? (s2[e3 + -2 >> 1] | 0) == 46 : 0) e3 = (s2[e3 + -4 >> 1] | 0) == 46;
        else e3 = 0;
        return e3 | 0;
      }
      function Q() {
        var e3 = 0;
        e3 = f2[69] | 0;
        e3 = f2[((e3 | 0) == 0 ? (f2[60] | 0) + 32 | 0 : e3 + 16 | 0) >> 2] | 0;
        f2[69] = e3;
        return (e3 | 0) != 0 | 0;
      }
      function R(e3) {
        e3 = e3 | 0;
        if ((f2[3] | 0) == (e3 | 0)) e3 = 1;
        else e3 = j(e3 + -2 | 0) | 0;
        return e3 | 0;
      }
      function V() {
        var e3 = 0;
        e3 = f2[(f2[61] | 0) + 12 >> 2] | 0;
        if (!e3) e3 = -1;
        else e3 = e3 - (f2[3] | 0) >> 1;
        return e3 | 0;
      }
      function W() {
        var e3 = 0;
        e3 = f2[(f2[60] | 0) + 12 >> 2] | 0;
        if (!e3) e3 = -1;
        else e3 = e3 - (f2[3] | 0) >> 1;
        return e3 | 0;
      }
      function X() {
        var e3 = 0;
        e3 = f2[(f2[61] | 0) + 8 >> 2] | 0;
        if (!e3) e3 = -1;
        else e3 = e3 - (f2[3] | 0) >> 1;
        return e3 | 0;
      }
      function Y() {
        var e3 = 0;
        e3 = f2[(f2[60] | 0) + 16 >> 2] | 0;
        if (!e3) e3 = -1;
        else e3 = e3 - (f2[3] | 0) >> 1;
        return e3 | 0;
      }
      function Z() {
        var e3 = 0;
        e3 = f2[(f2[60] | 0) + 4 >> 2] | 0;
        if (!e3) e3 = -1;
        else e3 = e3 - (f2[3] | 0) >> 1;
        return e3 | 0;
      }
      function _() {
        var e3 = 0;
        e3 = f2[60] | 0;
        e3 = f2[((e3 | 0) == 0 ? 232 : e3 + 36 | 0) >> 2] | 0;
        f2[60] = e3;
        return (e3 | 0) != 0 | 0;
      }
      function ee() {
        var e3 = 0;
        e3 = f2[61] | 0;
        e3 = f2[((e3 | 0) == 0 ? 236 : e3 + 20 | 0) >> 2] | 0;
        f2[61] = e3;
        return (e3 | 0) != 0 | 0;
      }
      function ae() {
        i3[806] = 1;
        f2[68] = (f2[73] | 0) - (f2[3] | 0) >> 1;
        f2[73] = (f2[74] | 0) + 2;
        return;
      }
      function re(e3) {
        e3 = e3 | 0;
        return e3 << 16 >> 16 == 39 | e3 << 16 >> 16 == 34 | 0;
      }
      function ie() {
        return (f2[(f2[61] | 0) + 16 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function se() {
        return (f2[(f2[69] | 0) + 12 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function fe() {
        return (f2[(f2[69] | 0) + 8 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function ce() {
        return (f2[(f2[69] | 0) + 4 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function te2() {
        return (f2[(f2[60] | 0) + 8 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function ne() {
        return (f2[(f2[61] | 0) + 4 >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function be(e3) {
        e3 = e3 | 0;
        return e3 << 16 >> 16 == 13 | e3 << 16 >> 16 == 10 | 0;
      }
      function ke() {
        return (f2[f2[69] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function le() {
        return (f2[f2[60] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function ue() {
        return (f2[f2[61] >> 2] | 0) - (f2[3] | 0) >> 1 | 0;
      }
      function oe() {
        return c2[(f2[60] | 0) + 24 >> 0] | 0 | 0;
      }
      function he(e3) {
        e3 = e3 | 0;
        f2[3] = e3;
        return;
      }
      function we() {
        return f2[(f2[60] | 0) + 28 >> 2] | 0;
      }
      function de() {
        return (i3[807] | 0) != 0 | 0;
      }
      function ve() {
        return (i3[808] | 0) != 0 | 0;
      }
      function Ae() {
        f2[69] = 0;
        return;
      }
      function Ce() {
        return f2[68] | 0;
      }
      function ge(e3, a3) {
        e3 = e3 | 0;
        a3 = a3 | 0;
        n2 = e3 + a3 + 15 & -16;
        return a3 | 0;
      }
      return { su: ge, ai: Y, ake: ce, aks: ke, ave: se, avs: fe, e: Ce, ee: ne, ele: V, els: X, es: ue, ess: ie, f: ve, id: J, ie: Z, ip: oe, is: le, it: we, ms: de, p: b3, ra: Q, re: ee, ri: _, rsa: Ae, sa: B, se: W, ses: he, ss: te2 };
    })("undefined" != typeof globalThis ? globalThis : self, {}, a), r = e.su(i2 - (2 << 17), 1040);
  }
  const h = c.length + 1;
  e.ses(r), e.sa(h - 1), s(c, new Uint16Array(a, r, h)), e.p() || (n = e.e(), o());
  const w = [], d = [];
  for (; e.ri(); ) {
    const a2 = e.is(), r2 = e.ie(), i3 = e.ai(), s2 = e.id(), f2 = e.ss(), t2 = e.se(), n2 = e.it();
    let k3;
    e.ip() && (k3 = b(-1 === s2 ? a2 : a2 + 1, c.charCodeAt(-1 === s2 ? a2 - 1 : a2)));
    let l3 = null;
    for (l3 = [], e.rsa(); e.ra(); ) {
      const a3 = e.aks(), r3 = e.ake(), i4 = e.avs(), s3 = e.ave();
      l3.push([v(a3, r3), v(i4, s3)]);
    }
    l3 = l3.length > 0 ? l3 : null, w.push({ t: n2, n: k3, s: a2, e: r2, ss: f2, se: t2, d: s2, a: i3, at: l3 });
  }
  for (; e.re(); ) {
    const a2 = e.es(), r2 = e.ee(), i3 = e.els(), s2 = e.ele(), f2 = i3 < 0 ? void 0 : v(i3, s2), c2 = v(a2, r2);
    d.push({ s: a2, e: r2, ls: i3, le: s2, ss: e.ess(), n: c2, ln: f2 });
  }
  return [w, d, !!e.f(), !!e.ms()];
  function v(e2, a2) {
    const r2 = c.charCodeAt(e2);
    return 34 === r2 || 39 === r2 ? b(e2 + 1, r2) : c.slice(e2, a2);
  }
}
function b(e2, a2) {
  n = e2;
  let r2 = "", i3 = n;
  for (; ; ) {
    n >= c.length && o();
    const e3 = c.charCodeAt(n);
    if (e3 === a2) break;
    92 === e3 ? (r2 += c.slice(i3, n), r2 += k(), i3 = n) : (8232 === e3 || 8233 === e3 || u(e3) && 96 !== a2 && o(), ++n);
  }
  return r2 += c.slice(i3, n++), r2;
}
function k() {
  let e2 = c.charCodeAt(++n);
  switch (++n, e2) {
    case 110:
      return "\n";
    case 114:
      return "\r";
    case 120:
      return String.fromCharCode(l(2));
    case 117:
      return (function() {
        const e3 = c.charCodeAt(n);
        let a2;
        123 === e3 ? (++n, a2 = l(c.indexOf("}", n) - n), ++n, a2 > 1114111 && o()) : a2 = l(4);
        return a2 <= 65535 ? String.fromCharCode(a2) : (a2 -= 65536, String.fromCharCode(55296 + (a2 >> 10), 56320 + (1023 & a2)));
      })();
    case 116:
      return "	";
    case 98:
      return "\b";
    case 118:
      return "\v";
    case 102:
      return "\f";
    case 13:
      10 === c.charCodeAt(n) && ++n;
    case 10:
      return "";
    case 56:
    case 57:
      o();
    default:
      if (e2 >= 48 && e2 <= 55) {
        let a2 = c.substr(n - 1, 3).match(/^[0-7]+/)[0], r2 = parseInt(a2, 8);
        return r2 > 255 && (a2 = a2.slice(0, -1), r2 = parseInt(a2, 8)), n += a2.length - 1, e2 = c.charCodeAt(n), "0" === a2 && 56 !== e2 && 57 !== e2 || o(), String.fromCharCode(r2);
      }
      return u(e2) ? "" : String.fromCharCode(e2);
  }
}
function l(e2) {
  const a2 = n;
  let r2 = 0, i3 = 0;
  for (let a3 = 0; a3 < e2; ++a3, ++n) {
    let e3, s2 = c.charCodeAt(n);
    if (95 !== s2) {
      if (s2 >= 97) e3 = s2 - 97 + 10;
      else if (s2 >= 65) e3 = s2 - 65 + 10;
      else {
        if (!(s2 >= 48 && s2 <= 57)) break;
        e3 = s2 - 48;
      }
      if (e3 >= 16) break;
      i3 = s2, r2 = 16 * r2 + e3;
    } else 95 !== i3 && 0 !== a3 || o(), i3 = s2;
  }
  return 95 !== i3 && n - a2 === e2 || o(), r2;
}
function u(e2) {
  return 13 === e2 || 10 === e2;
}
function o() {
  throw Object.assign(Error(`Parse error ${t}:${c.slice(0, n).split("\n").length}:${n - c.lastIndexOf("\n", n - 1)}`), { idx: n });
}

// src/closed-module.mjs
var forbidden = [
  /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*[(.]/,
  /\bimport\s*(?:["'`{*]|[\w$]+\s*(?:,|\bfrom\b))/,
  /\bexport\s*(?:\*|\{[^}]*\}\s*from\b)/,
  /\b(?:__)?require\s*\(/
];
function assertClosedModule(text) {
  let imports;
  try {
    [imports] = parse(text);
  } catch {
    throw new Error("backend_handlers_not_closed");
  }
  if (imports.length || forbidden.some((pattern) => pattern.test(text))) throw new Error("backend_handlers_not_closed");
}

// src/backend-artifact.mjs
var backendArtifactLimit = 2e6;
var handlerBuildOptions = Object.freeze({
  outfile: "handlers.mjs",
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  metafile: true,
  logLevel: "silent"
});
function yamlSourcesFrom(files) {
  const sources = Object.keys(files).filter((path) => path.startsWith("manifests/") && /\.ya?ml$/i.test(path.slice(path.lastIndexOf("/") + 1))).map((sourceId) => {
    if (sourceId.split("/").some((part) => part.startsWith("."))) throw new CloudRuleError(400, "manifest_path_hidden", sourceId);
    if (!/^[a-z0-9][a-z0-9_./-]*\.ya?ml$/.test(sourceId)) throw new CloudRuleError(400, "manifest_path_invalid", `${sourceId}: manifest paths are lowercase ASCII`);
    const bytes = files[sourceId];
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) throw new CloudRuleError(400, "manifest_bom", sourceId);
    try {
      return { sourceId, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      throw new CloudRuleError(400, "manifest_not_utf8", sourceId);
    }
  });
  if (!sources.length) throw new CloudRuleError(400, "manifests_missing", "no manifests/**/*.yaml");
  return sources.sort((a2, b3) => Buffer.compare(Buffer.from(a2.sourceId), Buffer.from(b3.sourceId)));
}
function closedHandlers(result) {
  const open = new CloudRuleError(400, "backend_handlers_not_closed", "the handler bundle must have no imports or dynamic imports");
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some((output) => output.imports.length) || Object.values(result.metafile.inputs).some((input) => input.imports.some((item) => item.kind === "dynamic-import"))) throw open;
  try {
    assertClosedModule(result.outputFiles[0].text);
  } catch {
    throw open;
  }
  return result.outputFiles[0].text;
}
function serializeBackend({ sources, handlers, cliVersion: cliVersion2 }) {
  const text = JSON.stringify({ version: 1, sdkVersion: corePin.version, sdkRevision: corePin.revision, cliVersion: cliVersion2, sources, handlers });
  const bytes = Buffer.byteLength(text);
  if (bytes > backendArtifactLimit) throw new CloudRuleError(400, "backend_artifact_too_large", `${bytes} bytes; Cloud accepts ${backendArtifactLimit}`);
  return { text, bytes, sha256: createHash2("sha256").update(text).digest("hex") };
}

// src/pack.mjs
var defaultSourceExcludes = Object.freeze([".git", "node_modules", ".wrangler"]);
var ignoredDistFiles = Object.freeze([".DS_Store", "Thumbs.db"]);
var sha256 = (bytes) => createHash3("sha256").update(bytes).digest("hex");
var posix = (path) => path.split(sep2).join("/");
async function walk2(root, visit, skip = () => false) {
  async function step(dir) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a2, b3) => a2.name < b3.name ? -1 : a2.name > b3.name ? 1 : 0);
    for (const entry of entries) {
      const path = join2(dir, entry.name), rel = posix(relative(root, path));
      if (skip(rel, entry)) continue;
      if (entry.isSymbolicLink()) throw new CloudRuleError(400, "symlink_unsupported", rel);
      if (entry.isDirectory()) await step(path);
      else if (entry.isFile()) await visit(rel, path);
      else throw new CloudRuleError(400, "special_file_unsupported", rel);
    }
  }
  await step(root);
}
async function readDist(distArg, ignored = []) {
  const dist = await realpath(resolve(distArg));
  if (!(await lstat2(dist)).isDirectory()) throw new CloudRuleError(400, "dist_not_directory");
  const files = /* @__PURE__ */ Object.create(null), secrets = [];
  await walk2(
    dist,
    async (rel, path) => {
      if (secretSourcePath(rel)) secrets.push(rel);
      else files["/" + rel] = new Uint8Array(await readFile2(path));
    },
    (rel, entry) => {
      if (entry.isDirectory() && [".git", ".mantle", "node_modules"].includes(entry.name.toLowerCase())) throw new CloudRuleError(400, "dist_path_unsafe", rel);
      return entry.isFile() && ignoredDistFiles.includes(entry.name) && Boolean(ignored.push("/" + rel));
    }
  );
  if (secrets.length) throw new CloudRuleError(400, "static_asset_secret_path", secrets.join(", "));
  return files;
}
async function readSource(projectArg, excludes = []) {
  const project = await realpath(resolve(projectArg));
  const skipped = excludes.map((item) => posix(item).replace(/^\.\/+/, "").replace(/\/+$/, "")).filter(Boolean);
  const excluded = /* @__PURE__ */ new Set();
  const skip = (rel, entry) => {
    const hit = defaultSourceExcludes.includes(entry.name) || skipped.some((item) => rel === item || rel.startsWith(item + "/"));
    if (hit) excluded.add(rel);
    return hit;
  };
  const files = /* @__PURE__ */ Object.create(null), secrets = [], seen = /* @__PURE__ */ new Map();
  let expanded = 0;
  await walk2(project, async (rel, path) => {
    if (secretSourcePath(rel)) {
      secrets.push(rel);
      return;
    }
    const key = sourcePathKey(rel);
    if (seen.has(key)) throw new CloudRuleError(400, "source_archive_duplicate_path", `${seen.get(key)} and ${rel}`);
    seen.set(key, rel);
    const bytes = new Uint8Array(await readFile2(path));
    expanded += bytes.byteLength;
    if (Object.keys(files).length >= sourceEntryLimit || expanded > sourceExpandedLimit) throw new CloudRuleError(400, "source_archive_expansion_limit");
    files[rel] = bytes;
  }, skip);
  if (secrets.length) throw new CloudRuleError(400, "source_archive_secret_path", secrets.join(", "));
  return { project, files, excluded: [...excluded].sort() };
}

// src/host/backend.mjs
import { lstatSync } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { dirname, extname, join as join3, relative as relative2, sep as sep3 } from "node:path";
var loaders = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".json": "json" };
var posix2 = (path) => path.split(sep3).join("/");
var configNames = ["package.json", "tsconfig.json", "jsconfig.json"];
function parseJsonc(text) {
  let out = "", pendingComma = false;
  for (let i3 = 0; i3 < text.length; ) {
    const c2 = text[i3];
    if (c2 === '"') {
      let end = i3 + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) throw new SyntaxError("unterminated string");
      if (pendingComma) out += ",";
      pendingComma = false;
      out += text.slice(i3, end + 1);
      i3 = end + 1;
      continue;
    }
    if (c2 === "/" && text[i3 + 1] === "/") {
      while (i3 < text.length && text[i3] !== "\n") i3++;
      continue;
    }
    if (c2 === "/" && text[i3 + 1] === "*") {
      const end = text.indexOf("*/", i3 + 2);
      if (end < 0) throw new SyntaxError("comment");
      i3 = end + 2;
      continue;
    }
    if (/\s/.test(c2)) {
      out += c2;
      i3++;
      continue;
    }
    if (c2 === ",") {
      if (pendingComma) throw new SyntaxError("comma");
      pendingComma = true;
      i3++;
      continue;
    }
    if (pendingComma && c2 !== "}" && c2 !== "]") out += ",";
    pendingComma = false;
    out += c2;
    i3++;
  }
  if (pendingComma) throw new SyntaxError("trailing comma");
  return JSON.parse(out);
}
function headTsconfig(files) {
  const name2 = Object.hasOwn(files, "tsconfig.json") ? "tsconfig.json" : Object.hasOwn(files, "jsconfig.json") ? "jsconfig.json" : null;
  if (!name2) return "{}";
  const text = new TextDecoder().decode(files[name2]);
  let doc;
  try {
    doc = parseJsonc(text.replace(/^\uFEFF/, ""));
  } catch {
    throw fail("handler_config_invalid", `${name2} is not valid JSON`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw fail("handler_config_invalid", name2);
  const extended = doc.extends === void 0 ? [] : Array.isArray(doc.extends) ? doc.extends : [doc.extends];
  const local = extended.filter((value) => typeof value !== "string" || !value || /^[./\\]|^[A-Za-z]:|:/.test(value) || value.split(/[\\/]/).includes(".."));
  if (local.length) throw fail("handler_config_unsupported", `${name2} extends ${local.map(String).join(", ")}; the handler bundle reads config from HEAD only, so extend a package or inline the options`);
  return JSON.stringify(doc);
}
function projectEsbuild(appRoot) {
  try {
    return createRequire2(join3(appRoot, "package.json"))("esbuild");
  } catch {
    throw fail("esbuild_missing", "add esbuild as a devDependency of the project and install it");
  }
}
async function bundleHandlers({ esbuild, top, appRoot, entry, files, omit = [] }) {
  let refusal = null;
  const refuse = (code, detail) => {
    refusal ??= fail(code, detail);
    return { errors: [{ text: code }] };
  };
  const checked = /* @__PURE__ */ new Set();
  const untrackedConfig = (dir) => {
    for (let at = dir; inside(appRoot, at) && !checked.has(at); at = dirname(at)) {
      checked.add(at);
      for (const name2 of configNames) {
        const rel = posix2(relative2(appRoot, join3(at, name2)));
        if (!Object.hasOwn(files, rel) && lstatSync(join3(at, name2), { throwIfNoEntry: false })) return rel;
      }
      if (at === appRoot) break;
    }
    return null;
  };
  const plugin = { name: "mantle-host-sources", setup(build) {
    build.onLoad({ filter: /.*/ }, (args) => {
      if (args.namespace !== "file") return refuse("handler_input_unsupported", args.namespace);
      const path = args.path;
      if (!inside(top, path)) return refuse("handler_input_outside_project", "a file outside the project");
      const rel = posix2(relative2(appRoot, path)), inRoot = inside(appRoot, path);
      const dependency = posix2(relative2(top, path)).split("/").includes("node_modules");
      const loader = loaders[extname(path).toLowerCase()];
      if (!files) return dependency || inRoot ? void 0 : refuse("handler_input_outside_root", posix2(relative2(top, path)));
      if (dependency && !(inRoot && Object.hasOwn(files, rel))) return void 0;
      if (!inRoot) return refuse("handler_input_outside_root", posix2(relative2(top, path)));
      if (!loader) return refuse("handler_input_unsupported", rel);
      if (omit.some((item) => rel === item || rel.startsWith(item + "/"))) return refuse("handler_input_omitted", rel);
      if (!Object.hasOwn(files, rel)) return refuse("handler_input_untracked", rel);
      const config = untrackedConfig(dirname(path));
      if (config) return refuse("handler_config_untracked", config);
      return { contents: files[rel], loader };
    });
  } };
  if (files && !Object.hasOwn(files, entry)) throw fail("handler_input_untracked", entry);
  const tsconfigRaw = files ? headTsconfig(files) : void 0;
  let result;
  try {
    result = await esbuild.build({
      ...handlerBuildOptions,
      entryPoints: [join3(appRoot, ...entry.split("/"))],
      absWorkingDir: appRoot,
      plugins: [plugin],
      ...tsconfigRaw === void 0 ? {} : { tsconfigRaw }
    });
  } catch (error) {
    if (refusal) throw refusal;
    throw fail("handler_build_failed", String(error?.errors?.[0]?.text ?? "esbuild failed").slice(0, 500));
  }
  if (refusal) throw refusal;
  try {
    return closedHandlers(result);
  } catch {
    throw fail("backend_handlers_not_closed", "the handler bundle must have no imports or dynamic imports");
  }
}
async function packBackendSnapshot({ esbuild, top, appRoot, entry, files, git: git2, omit, cliVersion: cliVersion2 }) {
  let sources;
  try {
    sources = yamlSourcesFrom(files);
  } catch (error) {
    throw error instanceof CloudRuleError ? error : fail("manifest_invalid", error.message);
  }
  const handlers = await bundleHandlers({ esbuild, top, appRoot, entry, files: git2 ? files : null, omit });
  return serializeBackend({ sources, handlers, cliVersion: cliVersion2 });
}

// src/host/snapshot.mjs
import { lstat as lstat3, readFile as readFile3, realpath as realpath2 } from "node:fs/promises";
import { dirname as dirname2, join as join5, relative as relative3, sep as sep4 } from "node:path";

// src/host/git.mjs
import { spawn } from "node:child_process";
import { accessSync, constants as constants2, realpathSync, statSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, isAbsolute, join as join4 } from "node:path";
var commands = /* @__PURE__ */ new Set(["rev-parse", "status", "ls-tree", "cat-file", "config"]);
var hardening = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, "-c", "core.untrackedCache=false", "--no-pager", "--no-replace-objects"];
var outputLimit = 128e6;
function gitEnv() {
  const kept = Object.fromEntries(["PATH", "Path", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== void 0).map((key) => [key, process.env[key]]));
  return {
    ...kept,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C"
  };
}
var executable = process.platform === "win32" ? "git.exe" : "git";
var resolved = /* @__PURE__ */ new Map();
function gitBinary(project) {
  if (resolved.has(project)) return resolved.get(project);
  const found = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter((dir) => dir && isAbsolute(dir)).map((dir) => {
    try {
      const real = realpathSync(dir);
      if (process.platform === "win32" ? inside(project.toLowerCase(), real.toLowerCase()) : inside(project, real)) return null;
      const path = join4(real, executable);
      if (!statSync(path).isFile()) return null;
      if (process.platform !== "win32") accessSync(path, constants2.X_OK);
      return path;
    } catch {
      return null;
    }
  }).find(Boolean);
  if (!found) throw fail("git_unavailable", "install git (outside the project) or pass --no-git");
  resolved.set(project, found);
  return found;
}
var utf8 = new TextDecoder("utf-8", { fatal: true });
function nulSeparated(bytes) {
  const records = [];
  for (let at = 0; at < bytes.length; ) {
    let end = bytes.indexOf(0, at);
    if (end < 0) end = bytes.length;
    if (end > at) {
      try {
        records.push(utf8.decode(bytes.subarray(at, end)));
      } catch {
        throw fail("source_path_not_utf8", "a tracked path is not valid UTF-8; rename it");
      }
    }
    at = end + 1;
  }
  return records;
}
function git(project, args, input) {
  const command = args.find((arg, index) => args[index - 1] !== "-c" && !arg.startsWith("-"));
  if (!commands.has(command) || command === "config" && args.slice(args.indexOf("config")).join(" ") !== "config --null --get-regexp ^filter\\.")
    throw new Error("git command not allowed");
  const binary = gitBinary(project);
  return new Promise((done, reject) => {
    let child;
    try {
      child = spawn(binary, [...hardening, "-C", project, ...args], { cwd: tmpdir(), env: gitEnv(), stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch {
      reject(fail("git_unavailable"));
      return;
    }
    const out = [], err2 = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > outputLimit) child.kill();
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (err2.length < 64) err2.push(chunk);
    });
    child.on("error", () => reject(fail("git_unavailable", "install git or pass --no-git")));
    child.on("close", (code) => {
      if (length > outputLimit) reject(fail("source_archive_expansion_limit"));
      else if (code === 0) done(Buffer.concat(out));
      else reject(Object.assign(new Error("git failed"), { gitCode: code, stderr: Buffer.concat(err2).toString("utf8").slice(0, 500) }));
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input ?? "");
  });
}
async function repository(project) {
  let text;
  try {
    text = (await git(project, ["rev-parse", "--show-toplevel", "--show-prefix"])).toString("utf8");
  } catch (error) {
    if (error.code) throw error;
    if (/dubious ownership/.test(error.stderr ?? "")) throw fail("git_repository_unsafe", "the repository is owned by another user; git refuses it without safe.directory, which this script does not read");
    throw fail("git_repository_missing", "commit the project to Git, or pass --no-git to save an unversioned copy");
  }
  const [top, prefix = ""] = text.split("\n");
  return { top, prefix: prefix.replace(/\/$/, "") };
}
async function headCommit(project) {
  let commit;
  try {
    commit = (await git(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"])).toString("utf8").trim();
  } catch (error) {
    if (error.code) throw error;
    throw fail("git_head_missing", "commit the project first");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail("git_head_missing");
  return commit;
}
async function filterOverrides(project) {
  let raw;
  try {
    raw = await git(project, ["config", "--null", "--get-regexp", "^filter\\."]);
  } catch (error) {
    if (error.gitCode === 1) return [];
    throw error;
  }
  const names = new Set(nulSeparated(raw).map((entry) => entry.split("\n", 1)[0]).map((key) => key.slice("filter.".length, key.lastIndexOf("."))));
  if ([...names].some((name2) => !name2 || /[=\s\u0000-\u001f\u007f]/.test(name2))) throw fail("git_filter_unsafe", "a filter driver name in the repository config cannot be switched off; remove it from .git/config");
  return [...names].flatMap((name2) => ["clean", "smudge", "process"].flatMap((key) => ["-c", `filter.${name2}.${key}=`]).concat(["-c", `filter.${name2}.required=false`]));
}
async function dirtyPaths(project) {
  const raw = await git(project, [...await filterOverrides(project), "-c", "core.autocrlf=true", "-c", "core.safecrlf=false", "--no-literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all", "--no-renames", "--", ".", ":(exclude).mantle/host"]);
  return nulSeparated(raw).map((entry) => entry.slice(3));
}
async function listTree(project, commit, path) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail("git_head_missing");
  let raw;
  try {
    raw = await git(project, ["ls-tree", "-r", "-z", "-l", "--full-tree", `${commit}:${path}`]);
  } catch (error) {
    if (error.code) throw error;
    throw fail("link_root_missing", path || ".");
  }
  return nulSeparated(raw).map((line) => {
    const tab = line.indexOf("	");
    const [mode, type, oid, size] = line.slice(0, tab).split(/ +/);
    return { mode, type, oid, size: size === "-" ? 0 : Number(size), path: line.slice(tab + 1) };
  });
}
async function trackedUnder(project, commit, prefix, dir) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail("git_head_missing");
  return nulSeparated(await git(project, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "--full-tree", `${commit}:${prefix}`, "--", dir]));
}
async function headEntries(project, commit, paths) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw fail("git_head_missing");
  if (!paths.length) return /* @__PURE__ */ new Map();
  const raw = await git(project, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", ...paths]);
  return new Map(nulSeparated(raw).map((line) => {
    const tab = line.indexOf("	"), [mode, , oid] = line.slice(0, tab).split(" ");
    return [line.slice(tab + 1), { mode, oid }];
  }));
}
async function readBlobs(project, oids) {
  const unique = [...new Set(oids)];
  if (!unique.length) return /* @__PURE__ */ new Map();
  if (unique.some((oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw fail("git_object_invalid");
  const out = await git(project, ["cat-file", "--batch"], unique.join("\n") + "\n");
  const blobs = /* @__PURE__ */ new Map();
  let at = 0;
  for (const oid of unique) {
    const end = out.indexOf(10, at);
    const [name2, type, size] = out.subarray(at, end).toString("utf8").split(" ");
    if (name2 !== oid || type !== "blob") throw fail("git_object_invalid", oid);
    const start = end + 1, length = Number(size);
    blobs.set(oid, new Uint8Array(out.subarray(start, start + length)));
    at = start + length + 1;
  }
  return blobs;
}

// src/host/snapshot.mjs
var listing = (paths) => paths.slice(0, 20).join(", ") + (paths.length > 20 ? ` and ${paths.length - 20} more` : "");
var covered = (path, list) => list.some((item) => path === item || path.startsWith(item + "/"));
function normalizeOmit(values = []) {
  const list = [...new Set(values.map((value) => String(value).replace(/^\.\/+/, "").replace(/\/+$/, "")))];
  if (list.length > 100 || list.some((value) => !omittablePath(value))) throw fail("omit_invalid", "each --omit is a relative path inside the app root (NFC, no .. or control characters), at most 100");
  return list.sort();
}
async function appRootOf(project, root) {
  const path = join5(project, ...root.split("/").filter(Boolean));
  let real;
  try {
    real = await realpath2(path);
  } catch {
    throw fail("link_root_missing", root || ".");
  }
  if (!inside(project, real) || !(await lstat3(real)).isDirectory()) throw fail("link_root_outside_project", root);
  return real;
}
async function currentHead(project, commit) {
  const head = await headCommit(project);
  if (commit && head !== commit) throw fail("head_changed", `HEAD is ${head}; this save started at ${commit}`);
  return head;
}
async function refuseDirty(project) {
  const dirty = await dirtyPaths(project);
  if (dirty.length) throw fail("worktree_dirty", listing(dirty));
}
async function cleanHead(project, commit) {
  const head = await currentHead(project, commit);
  const dirty = await dirtyPaths(project);
  if (dirty.length) throw fail("worktree_dirty", listing(dirty));
  return head;
}
async function gitSnapshot(project, { root, omit, commit: expected }) {
  const { top, prefix } = await repository(project);
  const commit = await currentHead(project, expected);
  const hostFiles = await trackedUnder(project, commit, prefix, ".mantle/host");
  if (hostFiles.length) throw fail("host_state_tracked", listing(hostFiles));
  const entries = await listTree(project, commit, joinRelative(prefix, root));
  const submodules = entries.filter((entry) => entry.mode === "160000").map((entry) => entry.path);
  if (submodules.length) throw fail("submodule_unsupported", listing(submodules));
  const links = entries.filter((entry) => entry.mode === "120000").map((entry) => entry.path);
  if (links.length) throw fail("symlink_unsupported", listing(links));
  await refuseDirty(project);
  const blobs = entries.filter((entry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"));
  const unmatched = omit.filter((item) => !blobs.some((entry) => covered(entry.path, [item])));
  if (unmatched.length) throw fail("omit_unmatched", listing(unmatched));
  const kept = blobs.filter((entry) => !covered(entry.path, omit));
  const secrets = kept.filter((entry) => secretSourcePath(entry.path)).map((entry) => entry.path);
  if (secrets.length) throw fail("source_archive_secret_path", listing(secrets));
  const keys = /* @__PURE__ */ new Map();
  for (const { path } of kept) {
    let key;
    try {
      key = sourcePathKey(path);
    } catch (error) {
      throw error.code === "source_archive_path_invalid" ? fail("source_archive_path_invalid", `${path}: an archive path cannot hold % : # ? \\ or control characters; rename it or pass --omit`) : error;
    }
    if (keys.has(key)) throw fail("source_archive_duplicate_path", `${keys.get(key)} and ${path}`);
    keys.set(key, path);
  }
  const bytes = kept.reduce((sum, entry) => sum + entry.size, 0);
  if (kept.length > sourceEntryLimit || bytes > sourceExpandedLimit)
    throw fail("source_archive_expansion_limit", `${kept.length} files, ${bytes} bytes; the limit is ${sourceEntryLimit} files and ${sourceExpandedLimit} bytes`);
  const read = await readBlobs(project, kept.map((entry) => entry.oid));
  const files = /* @__PURE__ */ Object.create(null);
  for (const entry of kept) files[entry.path] = read.get(entry.oid);
  const realTop = await realpath2(top);
  await ancestorPackages(project, { top: realTop, appRoot: await realpath2(join5(project, ...root.split("/").filter(Boolean))), commit });
  return { commit, top: realTop, files };
}
var resolutionFields = ["browser", "imports", "exports"];
async function ancestorPackages(project, { top, appRoot, commit }) {
  const inRepo = [], outside = [];
  for (let dir = dirname2(appRoot), last = appRoot; dir !== last; last = dir, dir = dirname2(dir)) {
    const path = join5(dir, "package.json");
    if (!await lstat3(path).catch(() => null)) continue;
    if (inside(top, dir)) inRepo.push(path);
    else outside.push(path);
  }
  for (const path of outside) {
    let doc = null;
    try {
      doc = JSON.parse((await readFile3(path, "utf8")).replace(/^\uFEFF/, ""));
    } catch {
      doc = null;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw fail("handler_config_outside_project", `${path} cannot be checked (not a JSON object); move the project or fix that file`);
    if (resolutionFields.some((field) => Object.hasOwn(doc, field)))
      throw fail("handler_config_outside_project", `${path} sets ${resolutionFields.filter((field) => Object.hasOwn(doc, field)).join(", ")}, which would change how the handlers resolve`);
  }
  if (!commit || !inRepo.length) return;
  const rels = inRepo.map((path) => relative3(top, path).split(sep4).join("/"));
  const head = await headEntries(project, commit, rels);
  const missing = rels.filter((rel) => head.get(rel)?.mode !== "100644" && head.get(rel)?.mode !== "100755");
  if (missing.length) throw fail("handler_config_untracked", listing(missing));
  const blobs = await readBlobs(project, rels.map((rel) => head.get(rel).oid));
  const text = (bytes) => Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
  const changed = [];
  for (const [index, rel] of rels.entries()) if (text(await readFile3(inRepo[index])) !== text(blobs.get(head.get(rel).oid))) changed.push(rel);
  if (changed.length) throw fail("worktree_dirty", listing(changed));
}
async function diskSnapshot(project, appRoot, { omit, dist }) {
  const own = [join5(project, ".mantle", "host"), dist].filter(Boolean).filter((path) => inside(appRoot, path) && path !== appRoot).map((path) => relative3(appRoot, path).split(sep4).join("/"));
  const { files } = await readSource(appRoot, [...omit, ...own]);
  if (Object.keys(files).length > sourceEntryLimit) throw fail("source_archive_expansion_limit");
  await ancestorPackages(project, { top: project, appRoot, commit: null });
  return { commit: "unversioned", top: project, files };
}

// src/host/save.mjs
var reuseMs = 25 * 6e4;
var second = 1e3;
var unsafeDist = Object.freeze([".git", ".mantle", "node_modules"]);
var commitOf = (pending) => pending.mode === "git" ? pending.commit : "unversioned";
var requiresVersion = (projectId) => [{ argument: "expectedVersion", tool: "member-project", arguments: { projectId }, field: "version" }];
function backendNext(ctx, pending) {
  const { entry } = ctx.link;
  const confirm = ctx.targetState.confirmedLink !== ctx.link.hash;
  return {
    kind: "mcp",
    tool: "cloud-backend-upload",
    arguments: { projectId: entry.projectId, operationId: pending.backend.operationId, contentHash: pending.backend.contentHash },
    requires: requiresVersion(entry.projectId),
    command: ctx.resume(true),
    // Literal lookups (the view parameters in Control's manifest) whose `name` the user confirms.
    ...confirm ? { confirm: [
      { tool: "member-organization", arguments: { organizationId: entry.organizationId }, field: "name" },
      { tool: "member-project", arguments: { projectId: entry.projectId }, field: "name" }
    ] } : {},
    reason: (confirm ? `${ctx.linkFile} is new or changed: call each confirm tool, show the user the organization and project names (site slug ${entry.slug}) and get confirmation before uploading. ` : "") + "Call the tool with these arguments plus expectedVersion from member-project, then pipe its result to the command. A retry reuses this operationId."
  };
}
function staticNext(ctx, pending) {
  const { entry } = ctx.link;
  return {
    kind: "mcp",
    tool: "cloud-static-frontend-upload",
    arguments: {
      projectId: entry.projectId,
      candidateId: pending.backend.candidateId,
      operationId: pending.static.operationId,
      contractHash: pending.contractHash,
      contentHash: pending.static.contentHash,
      sourceHash: pending.static.sourceHash,
      ...pending.mode === "git" ? { sourceRef: { commit: pending.commit } } : {},
      ...pending.omitted.length ? { omitted: pending.omitted } : {}
    },
    requires: requiresVersion(entry.projectId),
    command: ctx.resume(true),
    reason: "Call the tool with these arguments plus expectedVersion from member-project, then pipe its result to the command. A retry reuses this operationId."
  };
}
function buildNext(ctx, pending) {
  const { entry } = ctx.link;
  const kit = join6(ctx.project, ...outDir(ctx.target).split("/"), "kit"), dist = join6(ctx.project, ...joinRelative(entry.root, entry.frontend.dist).split("/"));
  const then = `then run \`${ctx.resume(false)}\``;
  return entry.frontend.build ? { kind: "build", command: entry.frontend.build, reason: `This build command comes from ${ctx.linkFile}; review it, run it in ${ctx.appRoot} (mantle-host never runs it), follow ${join6(kit, "AGENT.md")} so it writes static files to ${dist}, ${then}.` } : { kind: "build", reason: `Read ${join6(kit, "AGENT.md")}, build the frontend as static files into ${dist}, ${then}.` };
}
function saveFailureNext(ctx, code) {
  const pending = ctx.targetState?.pending;
  const fix = (reason) => ({ kind: "fix", command: ctx.line("save", ...ctx.targetArgs), reason });
  switch (code) {
    case "worktree_dirty":
      return fix("Commit the listed changes (untracked files count; ignore build output in .gitignore), then re-run save. There is no --allow-dirty.");
    case "head_changed":
      return { kind: "run", command: ctx.line("save", ...ctx.targetArgs, "--restart"), reason: "HEAD moved during this save. Start again from the new commit with a new operationId." };
    case "submodule_unsupported":
      return fix("Submodules are not uploaded. Vendor the listed paths or move them out of the app root.");
    case "symlink_unsupported":
      return fix("Replace the listed symlinks with regular files; symlinks could reach outside the project.");
    case "source_archive_secret_path":
      return fix("Remove the listed files from Git (git rm --cached, then ignore them) or pass --omit <path> for each; an omission is recorded and shown to the deployer. Cloud rejects secret paths instead of stripping them.");
    case "source_archive_expansion_limit":
      return fix("Pass --omit <path> for large tracked files that are not source; each omission is recorded and shown to the deployer.");
    case "host_state_tracked":
      return fix("Local mantle-host state is committed. Run git rm -r --cached .mantle/host, add .mantle/host/ to .gitignore and commit.");
    case "source_archive_path_invalid":
      return fix("Rename the listed tracked file, or pass --omit <path> for it; the omission is recorded and shown to the deployer.");
    case "dist_path_unsafe":
    case "dist_outside_root":
      return { kind: "fix", reason: `frontend.dist in ${ctx.linkFile} must be a build output directory inside the app root, never .git, .mantle or node_modules.` };
    case "static_asset_secret_path":
      return fix("The build output holds secret-named files (listed). Keep them out of the dist directory; they are rejected, not stripped.");
    case "handler_input_untracked":
      return fix("The handler bundle reads only committed files and node_modules. Commit the listed file or stop importing it.");
    case "handler_config_untracked":
      return fix("The handler bundle resolves with committed config only. Commit the listed file (or delete it) so the bundle is a function of HEAD.");
    case "handler_config_unsupported":
    case "handler_config_invalid":
      return fix("Fix the app-root tsconfig.json: it must be valid JSON(C) and may extend only a package, not a file.");
    case "handler_config_outside_project":
      return fix("A package.json above the project sets browser, imports or exports and would change how the handlers resolve. Move the project or remove those fields.");
    case "handler_input_omitted":
      return fix("The handler imports a path passed to --omit. Drop that --omit or stop importing it.");
    case "esbuild_missing":
      return fix("Add esbuild as a devDependency of the project and install it (mantle-host never installs packages), then re-run save.");
    case "git_repository_missing":
    case "git_head_missing":
      return fix("Commit the project to Git (save labels versions with the HEAD commit), or pass --no-git to save an unversioned copy.");
    case "dist_missing":
      return pending ? buildNext(ctx, pending) : fix("Build the frontend first.");
    case "client_outdated":
      return { kind: "fix", reason: `Cloud requires a newer mantle-host protocol. ${updateHost} Nothing was uploaded by this call.` };
    case "cli_core_mismatch":
      return { kind: "fix", reason: `Cloud pins another Mantle Core than this mantle-host. ${updateHost}` };
    case "grant_project_mismatch":
      return { kind: "fix", reason: `The grant is for another project than ${ctx.linkFile} names. Call the tool with exactly the arguments of the last nextAction.` };
    case "local_hash_mismatch":
    case "nothing_pending":
    case "link_changed":
    case "candidate_expired":
    case "static_upload_expired":
    case "candidate_upload_expired":
      return { kind: "run", command: ctx.line("save", ...ctx.targetArgs, "--restart"), reason: "This save cannot continue with the reserved operation. Start again with a new operationId." };
    case "cloud_unreachable":
    case "cloud_unavailable":
    case "save_timeout":
      return {
        kind: "wait",
        ...pending ? { command: ctx.resume(pending.stage !== "build") } : {},
        reason: "Wait a minute, call the same Cloud MCP tool with the SAME arguments for a fresh grant and pipe it to the command; Cloud resumes the same operation."
      };
    case "operation_mismatch":
    case "upload_grant_rejected":
    case "upload_grant_invalid":
    case "frontend_kit_unavailable":
    case "kit_url_expired":
    case "frontend_kit_grant_invalid":
    case "grant_invalid":
    case "grant_required":
    case "grant_invalid_json":
    case "grant_file_unreadable":
      if (pending?.stage === "backend") return backendNext(ctx, pending);
      if (pending?.stage === "static") return staticNext(ctx, pending);
      return fix("Pipe the Cloud MCP tool result on stdin with --grant -.");
    case "link_file_invalid":
    case "link_file_missing":
    case "link_target_required":
    case "link_target_unknown":
      return { kind: "fix", reason: `Fix ${ctx.linkFile} (it holds only ids, a slug and paths) or run link, then re-run save.` };
    default:
      return fix("Fix the reported problem and re-run save.");
  }
}
async function snapshot(ctx, pending, { distPath } = {}) {
  const { entry } = ctx.link;
  if (pending.mode === "git") return gitSnapshot(ctx.project, { root: entry.root, omit: pending.omitted, commit: pending.commit });
  return diskSnapshot(ctx.project, ctx.appRoot, { omit: pending.omitted, dist: distPath ?? join6(ctx.appRoot, ...entry.frontend.dist.split("/")) });
}
var outFile = (ctx, name2) => `${outDir(ctx.target)}/${name2}`;
async function readOwn(ctx, name2, hash, limit) {
  const bytes = await readInside(ctx.project, outFile(ctx, name2), limit);
  if (!bytes || sha256(bytes) !== hash) throw fail("local_hash_mismatch", `${name2} changed after it was reserved`, 409);
  return bytes;
}
async function startSave(ctx, flags) {
  const { entry } = ctx.link;
  const ts = ctx.targetState;
  const omitted = normalizeOmit(flags.omit);
  const mode = flags["no-git"] ? "unversioned" : "git";
  const snap = await snapshot(ctx, { mode, omitted });
  ctx.emit({
    ok: true,
    stage: "preflight",
    state: mode === "git" ? "clean" : "unversioned",
    commit: snap.commit,
    nextAction: null,
    notes: [`${Object.keys(snap.files).length} files`, ...omitted.length ? [`omitted: ${omitted.join(", ")}`] : []]
  });
  const artifact = await packBackendSnapshot({
    esbuild: projectEsbuild(ctx.appRoot),
    top: snap.top,
    appRoot: ctx.appRoot,
    entry: entry.handlers,
    files: snap.files,
    git: mode === "git",
    omit: omitted,
    cliVersion: `${hostName}@${cliVersion}`
  });
  await ensureDir(ctx.project, outDir(ctx.target));
  await writeAtomic(ctx.project, outFile(ctx, "backend.json"), artifact.text);
  const previous = ts.pending;
  const reuse = previous && !flags.restart && previous.linkHash === ctx.link.hash && previous.mode === mode && previous.commit === snap.commit && previous.backend.contentHash === artifact.sha256 && previous.omitted.join("\0") === omitted.join("\0") && ctx.now() - previous.backend.reservedAt < reuseMs;
  const pending = ts.pending = {
    stage: "backend",
    mode,
    commit: snap.commit,
    omitted,
    linkHash: ctx.link.hash,
    backend: reuse ? previous.backend : { operationId: randomUUID2(), contentHash: artifact.sha256, reservedAt: ctx.now(), candidateId: null }
  };
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "backend",
    state: "built",
    commit: snap.commit,
    verified: { contentHash: artifact.sha256, sourceHash: null, contractHash: null },
    nextAction: backendNext(ctx, pending)
  });
  return 0;
}
async function resumeSave(ctx, readGrant) {
  const pending = ctx.targetState.pending;
  if (!pending) throw fail("nothing_pending", "run save first");
  if (pending.linkHash !== ctx.link.hash) throw fail("link_changed", `${ctx.linkFile} changed during this save`);
  if (pending.mode === "git") await cleanHead(ctx.project, pending.commit);
  if (pending.stage === "backend") return resumeBackend(ctx, pending, await readGrant());
  if (pending.stage === "build") return packStatic(ctx, pending);
  if (pending.stage === "static") return resumeStatic(ctx, pending, await readGrant());
  throw fail("state_invalid");
}
async function until(ctx, deadline, step) {
  for (let attempt = 0; ; attempt++) {
    if (attempt) {
      if (ctx.now() >= deadline) throw fail("save_timeout", "Cloud did not finish in time", 503);
      await ctx.sleep(Math.min(2 * second * 2 ** (attempt - 1), 15 * second));
    }
    const done = await step(attempt);
    if (done) return done;
  }
}
async function resumeBackend(ctx, pending, raw) {
  const { entry } = ctx.link;
  const grant = unwrapResult(raw, "candidateId");
  if (!grant || !uuid.test(grant.candidateId ?? "") || !grant.poll || !("upload" in grant) || "staticUploadId" in grant) throw fail("grant_invalid", "expected the cloud-backend-upload result for this save");
  if (grant.projectId !== entry.projectId) throw fail("grant_project_mismatch", `${ctx.linkFile} names project ${entry.projectId}`);
  if (grant.contentHash !== pending.backend.contentHash) throw fail("local_hash_mismatch", "the grant reserves other bytes", 409);
  if (grant.operationId !== void 0 && grant.operationId !== pending.backend.operationId) throw fail("operation_mismatch");
  checkProtocol(grant.protocol);
  const id = grant.candidateId, path = `/api/cloud/backend-uploads/${id}`;
  const poll = grantUrl(grant.poll.url, path), pollAuth = bearerOf(grant.poll, ctx.output);
  const upload = grant.upload ? grantUrl(grant.upload.url, path, { origin: poll.origin }) : null;
  const uploadAuth = grant.upload ? bearerOf(grant.upload, ctx.output) : null;
  if (upload && grant.upload.method !== "PUT") throw fail("grant_invalid");
  const bytes = await readOwn(ctx, "backend.json", pending.backend.contentHash, 2e6);
  pending.backend.candidateId = id;
  ctx.targetState.confirmedLink = ctx.link.hash;
  await saveState(ctx.project, ctx.state);
  let status2 = grant.status, body = grant, uploaded = false;
  const deadline = ctx.now() + ctx.timeouts.backend;
  const ready = await until(ctx, deadline, async () => {
    if (upload && (status2 === "uploading" || status2 === "validating")) {
      try {
        body = await ctx.cloud.json(upload, { method: "PUT", authorization: uploadAuth, body: bytes, type: "application/json", timeout: 180 * second });
      } catch (error) {
        if (error.status === 503) return null;
        throw error;
      }
      if (body.candidateId !== id || body.contentHash !== pending.backend.contentHash) throw fail("cloud_response_mismatch");
      if (!uploaded) ctx.emit({ ok: true, stage: "backend", state: "uploaded", commit: commitOf(pending), nextAction: null });
      uploaded = true;
    } else body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 60 * second });
    if (body.status === "ready" && !("frontendKit" in body)) body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 60 * second });
    if (body.candidateId !== id) throw fail("cloud_response_mismatch");
    status2 = body.status;
    if (status2 === "failed") throw fail("candidate_failed", JSON.stringify((body.diagnostics ?? []).slice(0, 5)).slice(0, 1500));
    return status2 === "ready" && "frontendKit" in body ? body : null;
  });
  if (!ready.frontendKit) throw fail("frontend_kit_unavailable", typeof ready.frontendKitError === "string" ? ready.frontendKitError.slice(0, 100) : void 0);
  const kit = ready.frontendKit;
  if (!hex64.test(kit.zipSha256 ?? "") || !hex64.test(kit.contractHash ?? "")) throw fail("cloud_response_invalid");
  const kitUrl = grantUrl(kit.url, `/api/cloud/frontend-kits/${id}`, { origin: poll.origin, query: true });
  ctx.output.remember(kit.url);
  ctx.output.remember(kitUrl.search.slice(1));
  for (const value of kitUrl.searchParams.values()) ctx.output.remember(value);
  const zip = await ctx.cloud.bytes(kitUrl, { limit: kitLimitBytes, timeout: 60 * second });
  if (sha256(zip) !== kit.zipSha256) throw fail("kit_checksum_mismatch");
  const { entries } = extractKit(zip, { candidateId: id, contractHash: kit.contractHash });
  const dir = await resetDir(ctx.project, `${outDir(ctx.target)}/kit`);
  for (const name2 of kitFiles) await writeFile3(join6(dir, name2), entries[name2], { flag: "wx" });
  Object.assign(pending, { stage: "build", contractHash: kit.contractHash, kitZipSha256: kit.zipSha256 });
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "kit",
    state: "ready",
    commit: commitOf(pending),
    verified: { contentHash: pending.backend.contentHash, sourceHash: null, contractHash: kit.contractHash },
    nextAction: buildNext(ctx, pending)
  });
  return 0;
}
async function packStatic(ctx, pending) {
  const { entry } = ctx.link;
  const distPath = join6(ctx.appRoot, ...entry.frontend.dist.split("/"));
  const stat2 = await statPath(distPath).catch(() => null);
  if (!stat2?.isDirectory()) throw fail("dist_missing", distPath);
  const dist = await realpath3(distPath);
  if (!inside(ctx.appRoot, dist) || dist === ctx.appRoot) throw fail("dist_outside_root", entry.frontend.dist);
  if (relative4(ctx.appRoot, dist).split(sep5).some((part) => unsafeDist.includes(part.toLowerCase())) || inside(join6(ctx.project, ".git"), dist) || inside(join6(ctx.project, ".mantle"), dist))
    throw fail("dist_path_unsafe", entry.frontend.dist);
  const kitBytes = await readInside(ctx.project, `${outDir(ctx.target)}/kit/kit.json`, 1e6);
  let kit = null;
  try {
    kit = JSON.parse(new TextDecoder().decode(kitBytes));
  } catch {
  }
  if (kit?.candidateId !== pending.backend.candidateId || kit?.contractHash !== pending.contractHash) throw fail("kit_contract_mismatch", "the downloaded kit changed; run save --restart");
  if (kit.coreRevision !== corePin.revision) throw fail("cli_core_mismatch", void 0, 409);
  const ignored = [];
  const frontendText = serializeStaticArtifact(await readDist(dist, ignored), { sdkRevision: corePin.revision, spa: entry.frontend.spa });
  const snap = await snapshot(ctx, pending, { distPath: dist });
  const backend = JSON.parse(new TextDecoder().decode(await readOwn(ctx, "backend.json", pending.backend.contentHash, 2e6)));
  if (pending.mode !== "git") {
    const again = await packBackendSnapshot({
      esbuild: projectEsbuild(ctx.appRoot),
      top: snap.top,
      appRoot: ctx.appRoot,
      entry: entry.handlers,
      files: snap.files,
      git: false,
      omit: pending.omitted,
      cliVersion: `${hostName}@${cliVersion}`
    });
    if (again.sha256 !== pending.backend.contentHash) throw fail("local_hash_mismatch", "the manifests or handlers changed after the backend upload", 409);
  }
  const zip = canonicalSourceZip(snap.files);
  inspectSourceArchive(zip, backend.sources);
  const frontend = new TextEncoder().encode(frontendText);
  await writeAtomic(ctx.project, outFile(ctx, "static-frontend.json"), frontend);
  await writeAtomic(ctx.project, outFile(ctx, "source.zip"), zip);
  const hashes = { contentHash: sha256(frontend), sourceHash: sha256(zip) };
  const previous = pending.static;
  const reuse = previous && previous.contentHash === hashes.contentHash && previous.sourceHash === hashes.sourceHash && ctx.now() - previous.reservedAt < reuseMs;
  Object.assign(pending, { stage: "static", static: reuse ? previous : { operationId: randomUUID2(), ...hashes, reservedAt: ctx.now() } });
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "static",
    state: "built",
    commit: commitOf(pending),
    verified: { contentHash: hashes.contentHash, sourceHash: hashes.sourceHash, contractHash: pending.contractHash },
    notes: [
      `${Object.keys(snap.files).length} source files`,
      ...ignored.length ? [`skipped in dist: ${ignored.join(", ")}`] : [],
      ...pending.omitted.length ? [`omitted: ${pending.omitted.join(", ")}`] : []
    ],
    nextAction: staticNext(ctx, pending)
  });
  return 0;
}
async function resumeStatic(ctx, pending, raw) {
  const { entry } = ctx.link;
  const grant = unwrapResult(raw, "staticUploadId");
  const id = pending.static.operationId;
  if (!grant || grant.staticUploadId !== id) throw fail("grant_invalid", "expected the cloud-static-frontend-upload result for this save");
  if (grant.projectId !== entry.projectId) throw fail("grant_project_mismatch", `${ctx.linkFile} names project ${entry.projectId}`);
  if (grant.candidateId !== pending.backend.candidateId || grant.contentHash !== pending.static.contentHash || grant.sourceHash !== pending.static.sourceHash || grant.contractHash !== void 0 && grant.contractHash !== pending.contractHash) throw fail("local_hash_mismatch", "the grant reserves other bytes", 409);
  checkProtocol(grant.protocol);
  const parts = {
    frontend: { path: `/api/cloud/static-uploads/${id}`, file: "static-frontend.json", hash: pending.static.contentHash, type: "application/json", limit: staticFrontendLimit },
    source: { path: `/api/cloud/static-sources/${id}`, file: "source.zip", hash: pending.static.sourceHash, type: "application/zip", limit: sourceArchiveLimit }
  };
  const poll = grantUrl(grant.poll?.url, parts.frontend.path), pollAuth = bearerOf(grant.poll, ctx.output);
  const loaded = {};
  for (const [kind, part] of Object.entries(parts)) {
    if (!grant[kind] || grant[kind].method !== "PUT") throw fail("grant_invalid", kind);
    part.url = grantUrl(grant[kind].url, part.path, { origin: poll.origin });
    part.authorization = bearerOf(grant[kind], ctx.output);
    loaded[kind] = await readOwn(ctx, part.file, part.hash, part.limit);
  }
  let pairing = null;
  for (const [kind, part] of Object.entries(parts)) {
    if (grant[kind].uploaded) continue;
    const body = await ctx.cloud.json(part.url, { method: "PUT", authorization: part.authorization, body: loaded[kind], type: part.type, timeout: 180 * second });
    if (body.staticUploadId !== id || body.kind !== kind || body.hash !== part.hash) throw fail("cloud_response_mismatch", kind);
    pairing = body.pairing ?? pairing;
  }
  ctx.emit({ ok: true, stage: "static", state: "uploaded", commit: commitOf(pending), nextAction: null });
  let result = pairing?.status === "paired" || pairing?.status === "failed" ? { status: pairing.status, failure: pairing.failure ?? null } : null;
  if (!result) result = await until(ctx, ctx.now() + ctx.timeouts.pairing, async () => {
    const body = await ctx.cloud.json(poll, { authorization: pollAuth, timeout: 150 * second });
    return ["paired", "failed", "blocked", "superseded"].includes(body.status) ? body : null;
  });
  if (result.status === "failed") throw fail("static_pair_failed", String(result.failure ?? "probe failed").slice(0, 200));
  if (result.status === "superseded") throw fail("static_pair_superseded", "another static upload was paired with this candidate later");
  if (result.status === "blocked") {
    const next = result.nextAction && typeof result.nextAction === "object" ? result.nextAction : null;
    throw Object.assign(fail("static_pair_blocked", String(result.reason ?? "").slice(0, 100)), next ? { nextAction: {
      kind: next.kind === "fix" ? "fix" : "mcp",
      ...typeof next.tool === "string" ? { tool: next.tool } : {},
      ...next.arguments && typeof next.arguments === "object" ? { arguments: next.arguments } : {},
      reason: String(next.reason ?? "").slice(0, 500)
    } } : {});
  }
  const versionId = `${pending.backend.candidateId}.${id}`;
  const ts = ctx.targetState;
  ts.versions = [
    ...ts.versions.filter((version) => version.versionId !== versionId),
    { versionId, commit: commitOf(pending), candidateId: pending.backend.candidateId, staticUploadId: id, omitted: pending.omitted }
  ].slice(-50);
  ts.pending = null;
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "saved",
    state: "paired",
    versionId,
    commit: commitOf(pending),
    verified: { contentHash: pending.static.contentHash, sourceHash: pending.static.sourceHash, contractHash: pending.contractHash },
    nextAction: {
      kind: "mcp",
      tool: "cloud-backend-preview-grant",
      arguments: { projectId: entry.projectId, candidateId: pending.backend.candidateId },
      reason: `Saved, not published. Test the paired preview through the entrance this tool returns; to publish, a deployer runs \`${ctx.line("deploy", versionId, ...ctx.targetArgs)}\`.`
    }
  });
  return 0;
}

// src/host/release.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
var versionRule = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
function nativeNext(entry, verb) {
  if (entry.runtime === "cloudflare") {
    const config = entry.config && entry.config !== "wrangler.jsonc" ? ["--config", entry.config] : [];
    const command = ["pnpm", "exec", "wrangler", ...{ rollback: ["rollback"], status: ["deployments", "list"] }[verb] ?? ["deploy"], ...config].join(" ");
    return { kind: "run", command, reason: `This target deploys with wrangler (${entry.config ?? "wrangler.jsonc"}); mantle-host does not wrap it.` };
  }
  return { kind: "fix", reason: `This target is saved and deployed in ChatGPT Sites (${entry.config ?? ".openai/hosting.json"}); mantle-host does not wrap it.` };
}
async function link(ctx, flags) {
  const doc = await readLink(ctx.project) ?? { schemaVersion: 1, targets: {} };
  const names = Object.keys(doc.targets);
  const target = flags.target ?? (names.length === 1 ? names[0] : names.length ? null : "production");
  if (!target) throw fail("link_target_required", `pass --target with one of: ${names.join(", ")} or a new name`);
  const existing = doc.targets[target];
  const runtime = flags.runtime ?? existing?.runtime ?? "mantle-cloud";
  const base = existing?.runtime === runtime ? existing : { runtime };
  const drop = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0));
  const entry = runtime === "mantle-cloud" ? drop({
    ...base,
    organizationId: flags.organization ?? base.organizationId,
    projectId: flags.project ?? base.projectId,
    slug: flags.slug ?? base.slug,
    root: flags.root ?? base.root,
    handlers: flags.handlers ?? base.handlers,
    frontend: flags.dist || flags.spa || flags.build || base.frontend ? drop({
      ...base.frontend,
      dist: flags.dist ?? base.frontend?.dist,
      spa: flags.spa ?? base.frontend?.spa,
      build: flags.build ?? base.frontend?.build
    }) : void 0
  }) : drop({ ...base, config: flags.config ?? base.config });
  const next = { schemaVersion: 1, targets: { ...doc.targets, [target]: entry } };
  validateLink(next);
  await writeLink(ctx.project, next);
  const ignore = await readInside(ctx.project, ".gitignore", 1e6);
  const text = ignore ? new TextDecoder().decode(ignore) : "";
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (![".mantle/host/", ".mantle/host", "/.mantle/host/", "/.mantle/host", ".mantle/host/**"].some((pattern) => lines.includes(pattern)))
    await appendInside(ctx.project, ".gitignore", (text && !text.endsWith("\n") ? "\n" : "") + ".mantle/host/\n");
  ctx.emit({
    ok: true,
    stage: "link",
    state: "linked",
    notes: [`target ${target} → ${runtime}${entry.projectId ? ` project ${entry.projectId}` : ""}`],
    nextAction: {
      kind: "run",
      command: `git add -- ${linkFile} .gitignore && git commit -m 'Link Mantle hosting'`,
      reason: "Commit the link file: save reads only committed files. The first save asks the user to confirm the organization and project by name."
    }
  });
  return 0;
}
async function status(ctx) {
  const { entry } = ctx.link, ts = ctx.targetState, pending = ts.pending;
  const latest = ts.versions.at(-1) ?? null;
  let nextAction;
  if (pending?.stage === "backend") nextAction = backendNext(ctx, pending);
  else if (pending?.stage === "build") nextAction = { kind: "run", command: ctx.resume(false), reason: "Build the frontend, then continue this save." };
  else if (pending?.stage === "static") nextAction = staticNext(ctx, pending);
  else if (latest) nextAction = {
    kind: "mcp",
    tool: "cloud-paired-review",
    arguments: { projectId: entry.projectId, staticUploadId: latest.staticUploadId },
    command: ctx.line("deploy", latest.versionId, ...ctx.targetArgs, "--review", "-"),
    reason: "Review the latest saved version; a deployer pipes the review to the command."
  };
  else nextAction = { kind: "run", command: ctx.line("save", ...ctx.targetArgs), reason: "Nothing is saved for this target yet." };
  ctx.emit({
    ok: true,
    stage: "status",
    state: pending ? `pending-${pending.stage}` : latest ? "saved" : "idle",
    ...latest ? { versionId: latest.versionId } : {},
    commit: pending?.commit ?? latest?.commit ?? null,
    notes: [`project ${entry.projectId}`, `${ts.versions.length} saved versions`],
    nextAction
  });
  return 0;
}
function parseVersion(value) {
  const match = versionRule.exec(value ?? "");
  if (!match) throw fail("version_invalid", "a versionId is <candidateId>.<staticUploadId> as printed by save");
  return { versionId: value, candidateId: match[1], staticUploadId: match[2] };
}
var reviewSummary = (review) => ({
  backend: { contentHash: review.candidate?.contentHash ?? null, uploader: review.candidate?.uploader?.email ?? review.candidate?.uploader?.id ?? null, baseRevision: review.candidate?.baseRevision ?? null },
  static: {
    contentHash: review.static?.contentHash ?? null,
    sourceHash: review.static?.sourceHash ?? null,
    uploader: review.static?.uploader?.email ?? review.static?.uploader?.id ?? null,
    spa: review.static?.spa ?? null,
    files: (review.static?.files ?? []).slice(0, 100).map((file) => file.path),
    omitted: review.static?.omitted ?? []
  },
  sourceRef: review.static?.sourceRef?.commit ? `${review.static.sourceRef.commit} (unverified label, not provenance)` : "none (unversioned)",
  contractHash: review.contractHash ?? null,
  handlerRefs: (review.handlerRefs ?? []).slice(0, 100),
  yaml: review.yamlDiff ? { changed: review.yamlDiff.changed, added: review.yamlDiff.added, removed: review.yamlDiff.removed } : null,
  migration: review.migration ? {
    supported: review.migration.supported === true,
    destructive: review.migration.destructive ?? null,
    count: review.migration.count ?? null,
    ...review.migration.supported === true ? {} : { error: String(review.migration.error ?? "unsupported storage change").slice(0, 500) }
  } : null,
  live: review.live ?? null,
  evidence: review.validation?.evidence?.probes ? Object.fromEntries(Object.entries(review.validation.evidence.probes).map(([name2, probe]) => [name2, probe.ok ? "ok" : probe.reason ?? "failed"])) : null
});
async function deploy(ctx, positional, flags, readInput) {
  const { entry } = ctx.link;
  const version = parseVersion(positional);
  const again = [...flags["dry-run"] ? ["--dry-run"] : []];
  if (!flags.review) {
    ctx.emit({ ok: true, stage: "deploy", state: "review-needed", versionId: version.versionId, commit: null, nextAction: {
      kind: "mcp",
      tool: "cloud-paired-review",
      arguments: { projectId: entry.projectId, staticUploadId: version.staticUploadId },
      command: ctx.line("deploy", version.versionId, ...ctx.targetArgs, "--review", "-", ...again),
      reason: "Deploy is a separate, reviewed step for a project deployer. Pipe the review to the command."
    } });
    return 0;
  }
  if (flags.review !== "-") throw fail("usage", "pass --review - and pipe the cloud-paired-review result on stdin");
  const review = unwrapResult(await readInput(), "validation");
  if (!review || review.static?.id !== version.staticUploadId || review.candidate?.id !== version.candidateId) throw fail("review_mismatch", "pipe the cloud-paired-review result for this versionId");
  const summary = reviewSummary(review), commit = review.static?.sourceRef?.commit ?? "unversioned";
  const notes = [
    `backend ${summary.backend.contentHash} by ${summary.backend.uploader}`,
    `static ${summary.static.contentHash} by ${summary.static.uploader}, ${summary.static.files.length} files`,
    `source ${summary.static.sourceHash}, label ${summary.sourceRef}`,
    `omitted: ${summary.static.omitted.length ? summary.static.omitted.join(", ") : "none"}`,
    `handlers: ${summary.handlerRefs.join(", ") || "none"}`,
    `yaml: ${summary.yaml ? `+${summary.yaml.added} -${summary.yaml.removed}` : "no live comparison"}`,
    `migration: ${!summary.migration ? "unavailable (live schemas failed to compile)" : !summary.migration.supported ? `unsupported: ${summary.migration.error}` : `${summary.migration.count ?? 0} steps${summary.migration.destructive ? ", destructive" : ""}`}`,
    `evidence: ${summary.evidence ? Object.entries(summary.evidence).map(([name2, verdict]) => `${name2} ${verdict}`).join(", ") : "none"}`
  ];
  if (review.validation?.status !== "paired") throw Object.assign(
    fail("version_not_paired", String(review.validation?.status ?? "unknown")),
    { nextAction: { kind: "mcp", tool: "cloud-static-preview", arguments: { projectId: entry.projectId, staticUploadId: version.staticUploadId }, reason: "Only a paired version can be published." } }
  );
  if (summary.migration && (!summary.migration.supported || summary.migration.destructive)) {
    ctx.emit({
      ok: false,
      stage: "deploy",
      error: summary.migration.supported ? "migration_destructive" : "migration_unsupported",
      detail: notes.join("\n"),
      review: summary,
      nextAction: { kind: "fix", reason: "This version changes storage in a way Cloud cannot migrate automatically; nothing can be published. Change the manifests so the storage change is additive, then save a new version." }
    });
    return 1;
  }
  const active = review.live?.revision ?? null, base = review.candidate?.baseRevision ?? null;
  if (active !== base) throw Object.assign(
    fail("candidate_base_revision_changed", "the live revision moved after this candidate was built"),
    { nextAction: { kind: "run", command: ctx.line("save", ...ctx.targetArgs, "--restart"), reason: "Save a new version against the current live revision." } }
  );
  if (flags["dry-run"]) {
    ctx.emit({
      ok: true,
      stage: "deploy",
      state: "reviewed",
      versionId: version.versionId,
      commit,
      review: summary,
      notes,
      nextAction: { kind: "run", command: ctx.line("deploy", version.versionId, ...ctx.targetArgs, "--review", "-"), reason: "Dry run: nothing is published. Re-run without --dry-run, piping the same review, to get the publish call." }
    });
    return 0;
  }
  const ts = ctx.targetState;
  const saved = ts.deploys[version.versionId];
  const operationId = saved?.expectedActiveRevision === active && saved.operationId ? saved.operationId : randomUUID3();
  ts.deploys[version.versionId] = { operationId, expectedActiveRevision: active };
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "deploy",
    state: "reviewed",
    versionId: version.versionId,
    commit,
    review: summary,
    notes,
    nextAction: {
      kind: "mcp",
      tool: "cloud-publish-paired-release",
      arguments: {
        projectId: entry.projectId,
        candidateId: version.candidateId,
        staticUploadId: version.staticUploadId,
        expectedActiveRevision: active,
        operationId,
        ...active === null && review.live?.kind === "none" ? { slug: entry.slug } : {}
      },
      reason: "Show this review to the deployer and publish only after they confirm. Repeat the identical call while release.nextAction is retry_same_operation; report the site only after release.active and a live check."
    }
  });
  return 0;
}
async function rollback(ctx, positional, flags, readInput) {
  const { entry } = ctx.link;
  const version = positional ? parseVersion(positional) : null;
  if (flags.revision !== void 0 && !hex64.test(flags.revision)) throw fail("revision_invalid", "a revision is 64 lowercase hex characters");
  const select = [...version ? [version.versionId] : [], ...ctx.targetArgs, ...flags.revision ? ["--revision", flags.revision] : []];
  if (!flags.deployment) {
    ctx.emit({ ok: true, stage: "rollback", state: "deployment-needed", commit: null, nextAction: {
      kind: "mcp",
      tool: "cloud-project-deployment",
      arguments: { projectId: entry.projectId },
      command: ctx.line("rollback", ...select, "--deployment", "-"),
      reason: "Rollback is a reviewed step for a project deployer. Pipe the deployment to the command."
    } });
    return 0;
  }
  if (flags.deployment !== "-") throw fail("usage", "pass --deployment - and pipe the cloud-project-deployment result on stdin");
  const row = unwrapResult(await readInput(), "rows")?.rows?.find((item) => item?.projectId === entry.projectId);
  const active = row?.revision;
  if (!row || !hex64.test(active ?? "")) throw fail("nothing_to_roll_back", "the project has no active revision");
  const history = (Array.isArray(row.history) ? row.history : []).filter((item) => hex64.test(item?.revision ?? ""));
  let target = flags.revision ?? null;
  if (!target && version) {
    const operationId2 = ctx.targetState.deploys[version.versionId]?.operationId;
    if (operationId2 && row.operationId === operationId2) throw fail("version_is_active");
    target = history.find((item) => operationId2 && item.operationId === operationId2)?.revision ?? null;
    if (!target) throw fail("rollback_target_unknown", "this machine did not deploy that version; pass --revision <64-hex> from the deployment history");
  }
  target ??= history.filter((item) => item.revision !== active).at(-1)?.revision ?? null;
  if (!target || !history.some((item) => item.revision === target)) throw fail("rollback_target_unknown", "choose a retained revision from the deployment history with --revision");
  if (target === active) throw fail("version_is_active");
  const ts = ctx.targetState, key = `${active}:${target}`;
  const operationId = ts.rollbacks[key] ?? randomUUID3();
  ts.rollbacks = { [key]: operationId };
  await saveState(ctx.project, ctx.state);
  ctx.emit({
    ok: true,
    stage: "rollback",
    state: "ready",
    commit: null,
    notes: [`active ${active}`, `target ${target}`],
    nextAction: {
      kind: "mcp",
      tool: "cloud-rollback-project",
      arguments: { projectId: entry.projectId, operationId, expectedRevision: active, targetRevision: target },
      reason: "Confirm with the deployer: this restores Manifest, handlers, frontend and assets only, never data. Repeat the identical call until cloud-project-deployment reports targetRevision active."
    }
  });
  return 0;
}

// src/host/main.mjs
var usage = `${hostName} <command> [--target <name>] [--json]

  link    [--target <name>] [--runtime mantle-cloud|cloudflare|chatgpt-sites] [--organization <id>] [--project <id>]
          [--slug <slug>] [--root <dir>] [--handlers <file>] [--dist <dir>] [--spa] [--build <command>] [--config <file>]
  save    [--omit <path>]... [--no-git] [--restart]      pack HEAD and print the cloud-backend-upload call
  save    --resume [--grant - | --grant-file <path>]     continue with the piped Cloud MCP tool result
  status                                                 local state and the next step, no network
  deploy  <versionId> [--review -] [--dry-run]           review, then print the cloud-publish-paired-release call
  rollback [<versionId>] [--revision <hex>] [--deployment -]   print the cloud-rollback-project call
  version

Every step prints its nextAction: a literal {kind, tool?, arguments?, command?, reason?, requires?, confirm?}.
Grants come from Cloud MCP tool results on stdin (--grant -), --grant-file or MANTLE_CLOUD_GRANT and are never printed.`;
var options = {
  json: { type: "boolean" },
  target: { type: "string" },
  "no-git": { type: "boolean" },
  resume: { type: "boolean" },
  restart: { type: "boolean" },
  grant: { type: "string" },
  "grant-file": { type: "string" },
  omit: { type: "string", multiple: true },
  runtime: { type: "string" },
  organization: { type: "string" },
  project: { type: "string" },
  slug: { type: "string" },
  root: { type: "string" },
  handlers: { type: "string" },
  dist: { type: "string" },
  spa: { type: "boolean" },
  build: { type: "string" },
  config: { type: "string" },
  review: { type: "string" },
  "dry-run": { type: "boolean" },
  deployment: { type: "string" },
  revision: { type: "string" },
  help: { type: "boolean" }
};
var verbs = /* @__PURE__ */ new Set(["link", "save", "status", "deploy", "rollback", "version"]);
var inputLimit = 8e6;
async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > inputLimit) throw fail("input_too_large");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function main(args, io = {}) {
  const json = args.includes("--json");
  const output = createOutput({ json, write: io.write });
  const [verb] = args;
  const stage = verbs.has(verb) ? verb : "usage";
  let parsed;
  try {
    parsed = parseArgs({ args: args.slice(1), options, allowPositionals: true, strict: true });
  } catch {
    output.emit({ ok: false, stage, error: "usage", detail: "unknown or invalid option", nextAction: { kind: "fix", reason: usage.split("\n")[0] } });
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const help = flags.help || verb === "--help";
  if (!verbs.has(verb) || help) {
    (io.write ?? ((text) => process.stdout.write(text)))(usage + "\n");
    return verb && !help ? 2 : 0;
  }
  const scriptPath = io.scriptPath ?? fileURLToPath(import.meta.url);
  const script = `node ${shellWord(scriptPath)}`;
  const ctx = {
    output,
    json,
    emit: (line) => output.emit(line.ok ? {
      ...line,
      commit: line.commit ?? null,
      verified: line.verified ?? { contentHash: null, sourceHash: null, contractHash: null },
      nextAction: line.nextAction ?? null
    } : line),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    timeouts: { backend: 6 * 6e4, pairing: 10 * 6e4, ...io.timeouts },
    linkFile,
    targetArgs: []
  };
  ctx.line = (...words) => [script, ...words.map(shellWord), ...json ? ["--json"] : []].join(" ");
  try {
    if (verb === "version") {
      ctx.emit({ ok: true, stage, state: "local", version: cliVersion, protocol: hostProtocol.current, core: corePin, commit: null, nextAction: null });
      return 0;
    }
    ctx.project = await realpath4(resolve2(io.cwd ?? process.cwd()));
    if (verb === "link") return await link(ctx, flags);
    ctx.link = pickTarget(await readLink(ctx.project), flags.target);
    ctx.target = ctx.link.target;
    ctx.targetArgs = ["--target", ctx.target];
    ctx.resume = (grant) => ctx.line("save", "--target", ctx.target, "--resume", ...grant ? ["--grant", "-"] : []);
    if (ctx.link.entry.runtime !== "mantle-cloud") {
      ctx.emit({ ok: true, stage, state: "native", commit: null, nextAction: nativeNext(ctx.link.entry, verb) });
      return 0;
    }
    ctx.state = await loadState(ctx.project);
    ctx.targetState = targetState(ctx.state, ctx.target);
    ctx.appRoot = await appRootOf(ctx.project, ctx.link.entry.root);
    const scriptSha = await readFile4(scriptPath).then((bytes) => createHash4("sha256").update(bytes).digest("hex"), () => "unknown");
    ctx.cloud = cloudClient({ fetch: io.fetch ?? globalThis.fetch, client: `${hostName}/${cliVersion} sha256=${scriptSha}` });
    const readInput = async () => {
      const bytes = await (io.stdin ?? readStdin)();
      try {
        return JSON.parse(decodeInput(bytes));
      } catch {
        throw fail("input_invalid_json", "pipe the Cloud MCP tool result as JSON");
      }
    };
    const readGrant = async () => {
      if (flags.grant !== void 0 && flags["grant-file"] !== void 0) throw fail("usage", "pass either --grant - or --grant-file");
      let bytes;
      if (flags.grant !== void 0) {
        if (flags.grant !== "-") throw fail("grant_inline_refused", "pass --grant - and pipe the tool result on stdin; a grant on the command line reaches shell history");
        bytes = await (io.stdin ?? readStdin)();
      } else if (flags["grant-file"] !== void 0) {
        const path = resolve2(ctx.project, flags["grant-file"]);
        const unreadable = () => fail("grant_file_unreadable", "pass --grant - and pipe the Cloud MCP tool result on stdin");
        const info = await stat(path).catch(() => {
          throw unreadable();
        });
        if (!info.isFile()) throw unreadable();
        if (info.size > inputLimit) throw fail("input_too_large");
        bytes = await readFile4(path).catch(() => {
          throw unreadable();
        });
        if (bytes.byteLength > inputLimit) throw fail("input_too_large");
      } else if ((io.env ?? process.env).MANTLE_CLOUD_GRANT) bytes = (io.env ?? process.env).MANTLE_CLOUD_GRANT;
      else throw fail("grant_required", "pass --grant - and pipe the Cloud MCP tool result on stdin");
      let grant;
      try {
        grant = JSON.parse(decodeInput(bytes));
      } catch {
        throw fail("grant_invalid_json");
      }
      rememberCredentials(grant, output);
      return grant;
    };
    switch (verb) {
      case "save":
        return flags.resume ? await resumeSave(ctx, readGrant) : await startSave(ctx, flags);
      case "status":
        return await status(ctx);
      case "deploy":
        return await deploy(ctx, positionals[0], flags, readInput);
      case "rollback":
        return await rollback(ctx, positionals[0], flags, readInput);
    }
  } catch (error) {
    const code = error?.code && typeof error.code === "string" && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : "local_error";
    const nextAction = error?.nextAction ?? (verb === "save" || !ctx.link ? saveFailureNext(ctx, code) : { kind: "fix", reason: "Fix the reported problem and re-run." });
    ctx.emit(failureLine(stage, error, nextAction));
    return code === "usage" ? 2 : 1;
  }
  return 0;
}

// src/host/entry.mjs
process.exitCode = await main(process.argv.slice(2), { scriptPath: fileURLToPath2(import.meta.url) });
