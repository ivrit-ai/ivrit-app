(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const u of document.querySelectorAll('link[rel="modulepreload"]'))o(u);new MutationObserver(u=>{for(const s of u)if(s.type==="childList")for(const a of s.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&o(a)}).observe(document,{childList:!0,subtree:!0});function r(u){const s={};return u.integrity&&(s.integrity=u.integrity),u.referrerPolicy&&(s.referrerPolicy=u.referrerPolicy),u.crossOrigin==="use-credentials"?s.credentials="include":u.crossOrigin==="anonymous"?s.credentials="omit":s.credentials="same-origin",s}function o(u){if(u.ep)return;u.ep=!0;const s=r(u);fetch(u.href,s)}})();const R=["maxBufferSize","maxStorageBufferBindingSize","maxComputeWorkgroupStorageSize","maxComputeInvocationsPerWorkgroup","maxComputeWorkgroupSizeX","maxStorageBuffersPerShaderStage","maxBindGroups"];async function le(t={}){const e=globalThis.navigator?.gpu;if(!e)throw new Error("WebGPU is not available. Use Chrome/Edge 113+, Safari 18+, or Chrome on Android 121+.");const r=await e.requestAdapter({powerPreference:t.powerPreference??"high-performance"});if(!r)throw new Error("No WebGPU adapter found.");const o=[],u=r.features.has("shader-f16")&&!t.forceF32;u&&o.push("shader-f16");const s=r.features.has("timestamp-query");s&&o.push("timestamp-query");const a=r.features.has("subgroups");a&&o.push("subgroups");const n={},c=r.limits;for(const d of R){const v=c[d];typeof v=="number"&&(n[d]=v)}const l=await r.requestDevice({requiredFeatures:o,requiredLimits:n,label:"whisper-gpu"});l.onuncapturederror=d=>{const v=d.error;t.onError?t.onError(v):console.error("[whisper-gpu] uncaptured GPU error:",v.message)};const b=r.info,h=l.limits,m={f16:u,timestampQuery:s,subgroups:a,maxBufferSize:h.maxBufferSize,maxStorageBufferBindingSize:h.maxStorageBufferBindingSize,maxComputeInvocationsPerWorkgroup:h.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupStorageSize:h.maxComputeWorkgroupStorageSize,maxStorageBuffersPerShaderStage:h.maxStorageBuffersPerShaderStage,vendor:b?.vendor??"",architecture:b?.architecture??"",description:b?.description??""};return{adapter:r,device:l,queue:l.queue,caps:m,lost:l.lost}}function fe(t){return`${[t.vendor,t.architecture,t.description].filter(Boolean).join(" ")||"unknown adapter"} | f16=${t.f16} timestamps=${t.timestampQuery} maxBuffer=${t.maxBufferSize/1024/1024|0}MiB maxBinding=${t.maxStorageBufferBindingSize/1024/1024|0}MiB`}const p=256;class F{constructor(e,r=1024){this.device=e,this.buffer=e.createBuffer({size:r*p,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"uniform-arena"}),this.staging=new Uint8Array(p)}buffer;next=0;staging;alloc(e){const r=this.next*p;if(this.next++,e.byteLength>p)throw new Error(`uniform payload ${e.byteLength}B exceeds slot size ${p}B`);return this.write(r,e),r}write(e,r){this.staging.fill(0),this.staging.set(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),0),this.device.queue.writeBuffer(this.buffer,e,this.staging,0,p)}reset(){this.next=0}destroy(){this.buffer.destroy()}}class ce{constructor(e){this.ctx=e,this.device=e.device,this.uniforms=new F(e.device)}device;uniforms;layouts=new Map;pipelines=new Map;modules=new Map;bindGroups=new Map;bufferIds=new WeakMap;nextBufferId=1;layoutFor(e,r){const o=`${e}:${r}`;let u=this.layouts.get(o);if(u)return u;const s=[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",hasDynamicOffset:!0}}];for(let a=0;a<e;a++)s.push({binding:1+a,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}});for(let a=0;a<r;a++)s.push({binding:1+e+a,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}});return u=this.device.createBindGroupLayout({entries:s,label:`layout-${o}`}),this.layouts.set(o,u),u}moduleFor(e,r){let o=this.modules.get(r);return o||(o=this.device.createShaderModule({code:r,label:e}),this.modules.set(r,o)),o}kernel(e){const r=`${e.name}|${e.entry??"main"}|${JSON.stringify(e.constants??{})}|${I(e.code)}`,o=this.pipelines.get(r);if(o)return o;const u=this.layoutFor(e.writes,e.reads),s=this.device.createComputePipeline({label:e.name,layout:this.device.createPipelineLayout({bindGroupLayouts:[u],label:`${e.name}-pl`}),compute:{module:this.moduleFor(e.name,e.code),entryPoint:e.entry??"main",constants:e.constants}}),a={spec:e,pipeline:s,layout:u};return this.pipelines.set(r,a),a}idOf(e){let r=this.bufferIds.get(e);return r===void 0&&(r=this.nextBufferId++,this.bufferIds.set(e,r)),r}bindGroup(e,r,o=p){const u=r.map(l=>"buffer"in l?l.buffer:l),s=`${e.spec.name}:${e.layout.label}:${u.map(l=>this.idOf(l)).join(",")}`,a=this.bindGroups.get(s);if(a)return a;const n=[{binding:0,resource:{buffer:this.uniforms.buffer,offset:0,size:o}}];u.forEach((l,b)=>n.push({binding:1+b,resource:{buffer:l}}));const c=this.device.createBindGroup({layout:e.layout,entries:n,label:s});return this.bindGroups.set(s,c),c}destroy(){this.uniforms.destroy(),this.pipelines.clear(),this.bindGroups.clear(),this.modules.clear()}}class de{constructor(e,r=512){this.capacity=r,this.querySet=e.createQuerySet({type:"timestamp",count:r*2});const o=r*2*8;this.resolved=e.createBuffer({size:o,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,label:"profile-resolve"}),this.readback=e.createBuffer({size:o,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,label:"profile-readback"})}querySet;resolved;readback;labels=[];slot=0;totals=new Map;claim(e){if(this.slot>=this.capacity)return null;const r=this.slot++;return this.labels.push(e),{querySet:this.querySet,beginningOfPassWriteIndex:r*2,endOfPassWriteIndex:r*2+1}}resolve(e){this.slot!==0&&(e.resolveQuerySet(this.querySet,0,this.slot*2,this.resolved,0),e.copyBufferToBuffer(this.resolved,0,this.readback,0,this.slot*2*8))}async collect(){if(this.slot===0)return;await this.readback.mapAsync(GPUMapMode.READ,0,this.slot*2*8);const e=new BigUint64Array(this.readback.getMappedRange(0,this.slot*2*8).slice(0));this.readback.unmap();for(let r=0;r<this.slot;r++){if(e[r*2+1]===0n&&e[r*2]===0n)continue;const o=Number(e[r*2+1]-e[r*2])/1e6,u=this.labels[r].replace(/\.\d+\./,".*."),s=this.totals.get(u)??{ms:0,calls:0};s.ms+=o,s.calls++,this.totals.set(u,s)}this.slot=0,this.labels=[]}report(){return[...this.totals].map(([e,r])=>({label:e,ms:r.ms,calls:r.calls})).sort((e,r)=>r.ms-e.ms)}destroy(){this.querySet.destroy(),this.resolved.destroy(),this.readback.destroy()}}class be{constructor(e="graph"){this.label=e}nodes=[];cuts=[];add(e){return this.nodes.push(e),e}cut(){const e=this.nodes.length;e>0&&this.cuts[this.cuts.length-1]!==e&&this.cuts.push(e)}chunks(e=1){const r=[0,...this.cuts];r[r.length-1]!==this.nodes.length&&r.push(this.nodes.length);const o=[];for(let u=0;u<r.length-1;u+=e)o.push([r[u],r[Math.min(u+e,r.length-1)]]);return o}encode(e,r,o){const[u,s]=r??[0,this.nodes.length];if(o){for(let c=u;c<s;c++){const l=this.nodes[c],b=o.claim(l.label),h=e.beginComputePass(b?{label:l.label,timestampWrites:b}:{label:l.label});h.setPipeline(l.pipeline),h.setBindGroup(0,l.bindGroup,[l.uniformOffset]),h.dispatchWorkgroups(l.wg[0],l.wg[1],l.wg[2]),h.end()}return}const a=e.beginComputePass({label:this.label});let n=null;for(let c=u;c<s;c++){const l=this.nodes[c];l.pipeline!==n&&(a.setPipeline(l.pipeline),n=l.pipeline),a.setBindGroup(0,l.bindGroup,[l.uniformOffset]),a.dispatchWorkgroups(l.wg[0],l.wg[1],l.wg[2])}a.end()}}function I(t){let e=5381;for(let r=0;r<t.length;r++)e=(e<<5)+e+t.charCodeAt(r)|0;return e>>>0}function V(t,e){return`
@group(0) @binding(${t}) var<storage, read> ${e}: array<vec2<u32>>;
fn ${e}_load4(i: u32) -> vec4<f32> {
  let p = ${e}[i];
  return vec4<f32>(unpack2x16float(p.x), unpack2x16float(p.y));
}
fn ${e}_load1(i: u32) -> f32 {
  // Each vec2<u32> holds four halves: [x.lo, x.hi, y.lo, y.hi].
  let p = ${e}[i >> 2u];
  let two = unpack2x16float(select(p.x, p.y, (i & 2u) == 2u));
  return select(two.x, two.y, (i & 1u) == 1u);
}`}function W(t,e){return`
@group(0) @binding(${t}) var<storage, read> ${e}: array<u32>;
fn ${e}_load4(i: u32) -> vec4<f32> {
  let base = (i >> 3u) * 9u;
  let scale = unpack2x16float(${e}[base]).x;
  let w = ${e}[base + 1u + (i & 7u)];
  // Sign-extend four int8 by shifting each into the top byte and back down.
  let q = vec4<i32>(
    bitcast<i32>(w << 24u) >> 24u,
    bitcast<i32>(w << 16u) >> 24u,
    bitcast<i32>(w << 8u) >> 24u,
    bitcast<i32>(w) >> 24u,
  );
  return vec4<f32>(q) * scale;
}
fn ${e}_load1(i: u32) -> f32 {
  let base = (i >> 5u) * 9u;
  let scale = unpack2x16float(${e}[base]).x;
  let w = ${e}[base + 1u + ((i >> 2u) & 7u)];
  let q = bitcast<i32>(w << ((3u - (i & 3u)) * 8u)) >> 24u;
  return f32(q) * scale;
}`}function D(t,e){return`
@group(0) @binding(${t}) var<storage, read> ${e}: array<u32>;
fn ${e}_load4(i: u32) -> vec4<f32> {
  let base = (i >> 3u) * 5u;
  let sm = unpack2x16float(${e}[base]);
  let w = ${e}[base + 1u + ((i & 7u) >> 1u)] >> ((i & 1u) * 16u);
  let q = vec4<f32>(f32(w & 15u), f32((w >> 4u) & 15u), f32((w >> 8u) & 15u), f32((w >> 12u) & 15u));
  return q * sm.x + vec4<f32>(sm.y);
}
fn ${e}_load1(i: u32) -> f32 {
  let base = (i >> 5u) * 5u;
  let sm = unpack2x16float(${e}[base]);
  let j = i & 31u;
  let q = (${e}[base + 1u + (j >> 3u)] >> ((j & 7u) * 4u)) & 15u;
  return f32(q) * sm.x + sm.y;
}`}function j(t,e){return`
@group(0) @binding(${t}) var<storage, read> ${e}: array<u32>;
fn ${e}_load4(i: u32) -> vec4<f32> {
  let base = (i >> 3u) * 6u;
  let sm = unpack2x16float(${e}[base]);
  let w = ${e}[base + 1u + ((i & 7u) >> 1u)] >> ((i & 1u) * 16u);
  let h = ${e}[base + 5u] >> ((i & 7u) * 4u);
  let q = vec4<f32>(
    f32((w & 15u) | ((h & 1u) << 4u)),
    f32(((w >> 4u) & 15u) | (((h >> 1u) & 1u) << 4u)),
    f32(((w >> 8u) & 15u) | (((h >> 2u) & 1u) << 4u)),
    f32(((w >> 12u) & 15u) | (((h >> 3u) & 1u) << 4u)),
  );
  return q * sm.x + vec4<f32>(sm.y);
}
fn ${e}_load1(i: u32) -> f32 {
  let base = (i >> 5u) * 6u;
  let sm = unpack2x16float(${e}[base]);
  let j = i & 31u;
  let lo = (${e}[base + 1u + (j >> 3u)] >> ((j & 7u) * 4u)) & 15u;
  let hi = (${e}[base + 5u] >> j) & 1u;
  return f32(lo | (hi << 4u)) * sm.x + sm.y;
}`}function _(t,e,r="f16"){switch(r){case"q8":return W(t,e);case"q5":return j(t,e);case"q4":return D(t,e);default:return V(t,e)}}const q=`
fn erf_approx(x: f32) -> f32 {
  // Abramowitz & Stegun 7.1.26, max abs error ~1.5e-7.
  let s = sign(x);
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
      + 0.254829592) * t * exp(-a * a);
  return s * y;
}
fn gelu(x: f32) -> f32 {
  return 0.5 * x * (1.0 + erf_approx(x * 0.7071067811865476));
}
fn gelu4(v: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(gelu(v.x), gelu(v.y), gelu(v.z), gelu(v.w));
}`,y={bm:64,bn:64,bk:16,tm:4,tn:4};y.bm;y.bn;y.bk;function M(t){return t.bm/t.tm*(t.bn/t.tn)}function Y(t){return(t.bm+t.bn)*t.bk*4}function J(t){for(const[o,u]of Object.entries(t))if(!Number.isInteger(u)||u<=0)return`${o}=${u} must be a positive integer`;if(t.bm%t.tm||t.bn%t.tn)return"bm/bn must divide by tm/tn";if(t.bk%4)return"bk must be a multiple of 4";if(t.bm%4||t.bn%4)return"bm/bn must be multiples of 4";if(t.tm%4||t.tn%4)return"tm/tn must be multiples of 4";const e=M(t);if(e>256)return`${e} invocations exceeds the 256 default limit`;const r=Y(t);return r>16384?`${r}B workgroup storage exceeds the 16KiB default limit`:null}function $e(t){return new Uint32Array([t.M,t.N,t.K,t.lda??t.K,t.ldb??t.K,t.ldc??t.N,t.aOff??0,t.bOff??0,t.cOff??0,t.ldr??t.ldc??t.N,t.rOff??0,t.cin??0,t.stride??1,t.pad??0,t.tin??0,t.biasOff??0])}function he(t,e,r=y){return[Math.ceil(e/r.bn),Math.ceil(t/r.bm),1]}function A(t,e,r,o,u){const s=r/4,a=e*r/4,n=Math.ceil(a/o);let c="";for(let l=0;l<n;l++){const b=l===0?"lid":`lid + ${l*o}u`,h=a%o!==0&&l===n-1;c+=`
    {
      let li = ${b};
      ${h?`if (li < ${a}u) {`:""}
      let lrow = li / ${s}u;
      let lk = (li % ${s}u) * 4u;
      let kk = k0 + lk;
      ${u("lrow","kk","valid")}
      for (var t = 0u; t < 4u; t++) {
        ${t}[(lk + t) * ${e/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
      }
      ${h?"}":""}
    }`}return c}function ge(t,e=y){const r=J(e);if(r)throw new Error(`matmul tile ${JSON.stringify(e)}: ${r}`);const{bm:o,bn:u,bk:s,tm:a,tn:n}=e,c=M(e),l=4,b=(m,d)=>t.conv?`      let aRow = tileM + ${m};
      var v = vec4<f32>(0.0);
      if (aRow < P.M && ${d} < P.K) {
        // im2col: k decomposes into (kernel tap, input channel)
        let tap = ${d} / P.cin;
        let ci = ${d} % P.cin;
        let ti = i32(aRow * P.stride) + i32(tap) - i32(P.pad);
        if (ti >= 0 && ti < i32(P.tin)) {
          let o = P.aOff + u32(ti) * P.lda + ci;
          v = vec4<f32>(A[o], A[o + 1u], A[o + 2u], A[o + 3u]);
        }
      }`:`      let aRow = tileM + ${m};
      let aBase = P.aOff + aRow * P.lda;
      var v = vec4<f32>(0.0);
      if (aRow < P.M && ${d} + 3u < P.K) {
        let o = aBase + ${d};
        v = vec4<f32>(A[o], A[o + 1u], A[o + 2u], A[o + 3u]);
      } else if (aRow < P.M) {
        for (var t = 0u; t < 4u; t++) {
          if (${d} + t < P.K) { v[t] = A[aBase + ${d} + t]; }
        }
      }`,h=(m,d)=>`      let bRow = tileN + ${m};
      let bBase = P.bOff + bRow * P.ldb;
      var v = vec4<f32>(0.0);
      if (bRow < P.N && ${d} + 3u < P.K) {
        v = B_load4((bBase + ${d}) >> 2u);
      } else if (bRow < P.N) {
        for (var t = 0u; t < 4u; t++) {
          if (${d} + t < P.K) { v[t] = B_load1(bBase + ${d} + t); }
        }
      }`;return`
struct Params {
  M: u32, N: u32, K: u32,
  lda: u32, ldb: u32, ldc: u32,
  aOff: u32, bOff: u32, cOff: u32,
  ldr: u32, rOff: u32,
  cin: u32, stride: u32, pad: u32, tin: u32, biasOff: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> C: array<f32>;
@group(0) @binding(2) var<storage, read> A: array<f32>;
${_(3,"B",t.weights)}
${t.bias?`@group(0) @binding(${l}) var<storage, read> bias: array<f32>;`:""}
${t.act==="gelu"?q:""}

var<workgroup> As: array<vec4<f32>, ${s*o/4}>;
var<workgroup> Bs: array<vec4<f32>, ${s*u/4}>;

@compute @workgroup_size(${c})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let tileN = wg.x * ${u}u;
  let tileM = wg.y * ${o}u;
  let tx = lid % ${u/n}u;   // output column group
  let ty = lid / ${u/n}u;   // output row group

  var acc: array<vec4<f32>, ${a*n/4}>;
  for (var i = 0u; i < ${a*n/4}u; i++) { acc[i] = vec4<f32>(0.0); }

  for (var k0 = 0u; k0 < P.K; k0 += ${s}u) {
    // Scatter into k-major tiles so the inner loop reads contiguous vec4s.
${A("As",o,s,c,b)}
${A("Bs",u,s,c,h)}
    workgroupBarrier();

    for (var k = 0u; k < ${s}u; k++) {
${Array.from({length:a/4},(m,d)=>`      let a${d} = As[k * ${o/4}u + ty * ${a/4}u + ${d}u];`).join(`
`)}
${Array.from({length:n/4},(m,d)=>`      let b${d} = Bs[k * ${u/4}u + tx * ${n/4}u + ${d}u];`).join(`
`)}
${Array.from({length:a},(m,d)=>Array.from({length:n/4},(v,B)=>`      acc[${d*(n/4)+B}] += vec4<f32>(a${Math.floor(d/4)}[${d%4}]) * b${B};`).join(`
`)).join(`
`)}
    }
    workgroupBarrier();
  }

  let m0 = tileM + ty * ${a}u;
  let n0 = tileN + tx * ${n}u;
  for (var i = 0u; i < ${a}u; i++) {
    let m = m0 + i;
    if (m >= P.M) { continue; }
    for (var jb = 0u; jb < ${n/4}u; jb++) {
      var v = acc[i * ${n/4}u + jb];
      let n0b = n0 + jb * 4u;
      ${t.bias?"for (var j = 0u; j < 4u; j++) { if (n0b + j < P.N) { v[j] += bias[P.biasOff + n0b + j]; } }":""}
      let cBase = P.cOff + m * P.ldc + n0b;
      ${t.accumulate?"for (var j = 0u; j < 4u; j++) { if (n0b + j < P.N) { v[j] += C[cBase + j]; } }":""}
      ${t.act==="gelu"?"v = gelu4(v);":""}
      if (n0b + 3u < P.N) {
        C[cBase] = v.x; C[cBase + 1u] = v.y; C[cBase + 2u] = v.z; C[cBase + 3u] = v.w;
      } else {
        for (var j = 0u; j < 4u; j++) { if (n0b + j < P.N) { C[cBase + j] = v[j]; } }
      }
    }
  }
}`}const x={gn:64,tk:4,rows:8},me={gn:16,tk:8,rows:8};x.rows;function H(t){return t.gn*t.tk}function X(t){return t.gn*t.tk*t.rows*4}function Z(t){for(const o of["gn","tk","rows"]){const u=t[o];if(!Number.isInteger(u)||u<=0)return`${o}=${u} must be a positive integer`}if(t.tk&t.tk-1)return`tk=${t.tk} must be a power of two`;const e=H(t);if(e>256)return`${e} invocations exceeds the 256 default limit`;const r=X(t);return r>16384?`${r}B workgroup storage exceeds the 16KiB default limit`:null}function ve(t,e,r=x){return[Math.ceil(e/r.gn),1,1]}function pe(t,e=x){const r=Z(e);if(r)throw new Error(`gemv shape ${JSON.stringify(e)}: ${r}`);const{gn:o,tk:u,rows:s}=e,a=e.staticRows?`${s}u`:"rows";return`
struct Params {
  M: u32, N: u32, K: u32,
  lda: u32, ldb: u32, ldc: u32,
  aOff: u32, bOff: u32, cOff: u32,
  ldr: u32, rOff: u32,
  cin: u32, stride: u32, pad: u32, tin: u32, biasOff: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> C: array<f32>;
@group(0) @binding(2) var<storage, read> A: array<f32>;
${_(3,"B",t.weights)}
${t.bias?"@group(0) @binding(4) var<storage, read> bias: array<f32>;":""}
${t.act==="gelu"?q:""}

var<workgroup> red: array<f32, ${o*u*s}>;

@compute @workgroup_size(${o*u})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let col = lid / ${u}u;
  let lane = lid % ${u}u;
  let n = wg.x * ${o}u + col;
  // Out-of-range columns still run: every lane has to reach the barriers below.
  let live = n < P.N;
${e.staticRows?"":`  // Uniform across the workgroup, so the partial-sum slots each lane touches
  // line up with its reduction partner's.
  let rows = min(P.M, ${s}u);
`}
  var acc: array<f32, ${s}>;
  for (var m = 0u; m < ${s}u; m++) { acc[m] = 0.0; }

  let bBase = P.bOff + select(0u, n * P.ldb, live);
  for (var k = lane * 4u; k < P.K; k += ${u*4}u) {
    var bv = vec4<f32>(0.0);
    if (live && k + 3u < P.K) {
      bv = B_load4((bBase + k) >> 2u);
    } else if (live) {
      for (var t = 0u; t < 4u; t++) {
        if (k + t < P.K) { bv[t] = B_load1(bBase + k + t); }
      }
    }
    for (var m = 0u; m < ${a}; m++) {
      let aBase = P.aOff + m * P.lda + k;
      var av = vec4<f32>(0.0);
      if (k + 3u < P.K) {
        av = vec4<f32>(A[aBase], A[aBase + 1u], A[aBase + 2u], A[aBase + 3u]);
      } else {
        for (var t = 0u; t < 4u; t++) {
          if (k + t < P.K) { av[t] = A[aBase + t]; }
        }
      }
      acc[m] += dot(av, bv);
    }
  }

  for (var m = 0u; m < ${a}; m++) {
    red[lid * ${s}u + m] = acc[m];
  }
  workgroupBarrier();
  // Lanes of one column are contiguous in lid, so the partner index stays
  // inside this column's group for every step.
  for (var s = ${u/2}u; s > 0u; s >>= 1u) {
    if (lane < s) {
      for (var m = 0u; m < ${a}; m++) {
        red[lid * ${s}u + m] += red[(lid + s) * ${s}u + m];
      }
    }
    workgroupBarrier();
  }

  if (lane != 0u || !live) { return; }
  for (var m = 0u; m < ${a}; m++) {
    var v = red[lid * ${s}u + m];
    ${t.bias?"v += bias[P.biasOff + n];":""}
    let o = P.cOff + m * P.ldc + n;
    ${t.accumulate?"v += C[o];":""}
    ${t.act==="gelu"?"v = gelu(v);":""}
    C[o] = v;
  }
}`}const g=64,N={br:16,bc:64,bk:32,tm:4,tn:4},we={br:4,bc:64,bk:16,tm:4,tn:4};function k(t){return t.bc/t.tn}function U(t){return g/k(t)}function E(t){return t.br/t.tm*k(t)}function ee(t){const e=t.bk*t.br,r=t.bk*Math.max(t.bc,g);return(e+r+t.br*k(t))*4}function te(t){for(const[u,s]of Object.entries(t))if(!Number.isInteger(s)||s<=0)return`${u}=${s} must be a positive integer`;if(t.br%t.tm||t.bc%t.tn)return"br/bc must divide by tm/tn";if(t.tm%4||t.tn%4)return"tm/tn must be multiples of 4";if(t.bk%4)return"bk must be a multiple of 4";if(g%t.bk)return`bk must divide head_dim ${g}`;if(t.bc%t.bk||t.bk%t.tn)return"bk must divide bc and be a multiple of tn";const e=k(t);if(g%e||U(t)%4)return`bc/tn=${e} must divide head_dim ${g} into multiples of 4`;const r=E(t);if(r>256)return`${r} invocations exceeds the 256 default limit`;const o=ee(t);return o>16384?`${o}B workgroup storage exceeds the 16KiB default limit`:null}function ye(t,e=N){return[Math.ceil(t.T/e.br),t.heads,t.batch]}function ke(t,e,r={}){const o=new ArrayBuffer(96),u=new Uint32Array(o),s=new Float32Array(o);return u[0]=t.T,u[1]=t.S,u[2]=t.heads,u[3]=e.ldq,u[4]=e.ldk,u[5]=e.ldv,u[6]=e.ldo,u[7]=e.offQ??0,u[8]=e.offK??0,u[9]=e.offV??0,u[10]=e.offO??0,u[11]=e.bsQ??0,u[12]=e.bsK??0,u[13]=e.bsV??0,u[14]=e.bsO??0,u[15]=e.hsQ??g,u[16]=e.hsK??g,u[17]=e.hsV??g,u[18]=e.hsO??g,u[19]=r.qPos??0,u[20]=r.causal?1:0,s[21]=r.scale??1/Math.sqrt(g),new Uint8Array(o)}const $=(t,e)=>Array.from({length:t},(r,o)=>e(o)).join(`
`);function Be(t=!0,e=!1,r=N){const o=te(r);if(o)throw new Error(`attention tile ${JSON.stringify(r)}: ${o}`);const{br:u,bc:s,bk:a,tm:n,tn:c}=r,l=k(r),b=U(r),h=E(r),m=t?"K":"Q",d=t?"V":"Q",v=t?5:3,B=e?"path[b * P.S + key] * P.bsK + ":"",z=e?"path[b * P.S + key] * P.bsV + ":"",w=(i,f)=>`s[${i*(c/4)+(f>>2)}][${f&3}]`,O=a*u/4,L=a*Math.max(s,g)/4;return`
struct Params {
  T: u32, S: u32, H: u32,
  ldq: u32, ldk: u32, ldv: u32, ldo: u32,
  offQ: u32, offK: u32, offV: u32, offO: u32,
  bsQ: u32, bsK: u32, bsV: u32, bsO: u32,
  hsQ: u32, hsK: u32, hsV: u32, hsO: u32,
  qPos: u32, causal: u32, scale: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<storage, read> Q: array<f32>;
${t?"@group(0) @binding(3) var<storage, read> K: array<f32>;":""}
${t?"@group(0) @binding(4) var<storage, read> V: array<f32>;":""}
${e?`@group(0) @binding(${v}) var<storage, read> path: array<u32>;`:""}

// Q slice (head-dim major) during QK^T, then the score chunk during PV.
var<workgroup> SA: array<vec4<f32>, ${O}>;
// K slice (head-dim major) during QK^T, then the V chunk (row major) during PV.
var<workgroup> SB: array<vec4<f32>, ${L}>;
var<workgroup> red: array<f32, ${u*l}>;

const NEG_INF: f32 = -3.0e38;

@compute @workgroup_size(${h})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let q0 = wg.x * ${u}u;
  let h = wg.y;
  let b = wg.z;
  let ty = lid / ${l}u;   // query row group
  let tx = lid % ${l}u;   // key group during QK^T, head-dim group during PV
  let row0 = ty * ${n}u;    // first query row this thread owns, within the block

  let qBase = P.offQ + b * P.bsQ + h * P.hsQ;
  let kBase = P.offK + h * P.hsK + ${e?"0u":"b * P.bsK"};
  let vBase = P.offV + h * P.hsV + ${e?"0u":"b * P.bsV"};
  let oBase = P.offO + b * P.bsO + h * P.hsO;

  var acc: array<vec4<f32>, ${n*b/4}>;
${$(n*b/4,i=>`  acc[${i}] = vec4<f32>(0.0);`)}
  var s: array<vec4<f32>, ${n*c/4}>;
${$(n,i=>`  var m${i} = NEG_INF; var l${i} = 0.0; var rs${i} = 0.0;`)}

  for (var c0 = 0u; c0 < P.S; c0 += ${s}u) {
${$(n*c/4,i=>`    s[${i}] = vec4<f32>(0.0);`)}

    // --- scores: S[br, bc] = (scale * Q[br, 64]) K[bc, 64]^T ----------------
    for (var ks = 0u; ks < ${g}u; ks += ${a}u) {
      workgroupBarrier();
      for (var li = lid; li < ${O}u; li += ${h}u) {
        let lrow = li / ${a/4}u;
        let lk = (li % ${a/4}u) * 4u;
        let qrow = q0 + lrow;
        var v = vec4<f32>(0.0);
        if (qrow < P.T) {
          let o = qBase + qrow * P.ldq + ks + lk;
          v = vec4<f32>(Q[o], Q[o + 1u], Q[o + 2u], Q[o + 3u]) * P.scale;
        }
        for (var t = 0u; t < 4u; t++) {
          SA[(lk + t) * ${u/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      for (var li = lid; li < ${s*a/4}u; li += ${h}u) {
        let lrow = li / ${a/4}u;
        let lk = (li % ${a/4}u) * 4u;
        let key = c0 + lrow;
        var v = vec4<f32>(0.0);
        if (key < P.S) {
          let o = kBase + ${B}key * P.ldk + ks + lk;
          v = vec4<f32>(${m}[o], ${m}[o + 1u], ${m}[o + 2u], ${m}[o + 3u]);
        }
        for (var t = 0u; t < 4u; t++) {
          SB[(lk + t) * ${s/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      workgroupBarrier();
      for (var k = 0u; k < ${a}u; k++) {
${$(n/4,i=>`        let a${i} = SA[k * ${u/4}u + ty * ${n/4}u + ${i}u];`)}
${$(c/4,i=>`        let b${i} = SB[k * ${s/4}u + tx * ${c/4}u + ${i}u];`)}
${$(n,i=>$(c/4,f=>`        s[${i*(c/4)+f}] += vec4<f32>(a${Math.floor(i/4)}[${i%4}]) * b${f};`))}
      }
    }

${`
    // --- mask, then the running max over this block -------------------------
    workgroupBarrier(); // red still holds the previous block's sums
    let key0 = c0 + tx * ${c}u;
${$(n,i=>`    {
      let qp = P.qPos + q0 + row0 + ${i}u;
      var lm = NEG_INF;
${$(c,f=>`      let v${f} = select(NEG_INF, ${w(i,f)}, key0 + ${f}u < P.S && (P.causal == 0u || key0 + ${f}u <= qp));
      ${w(i,f)} = v${f};
      lm = max(lm, v${f});`)}
      red[(row0 + ${i}u) * ${l}u + tx] = lm;
    }`)}
    workgroupBarrier();

    // --- online softmax: rescale the running state, exponentiate the block --
    // Threads sharing a row group read every slot of that row, so the block max
    // has to be in registers everywhere before any of them reuses red for sums.
${$(n,i=>`    var bm${i} = NEG_INF;
    for (var t = 0u; t < ${l}u; t++) { bm${i} = max(bm${i}, red[(row0 + ${i}u) * ${l}u + t]); }`)}
    workgroupBarrier();
${$(n,i=>`    {
      let mNew = max(m${i}, bm${i});
      rs${i} = select(exp(m${i} - mNew), 0.0, m${i} == NEG_INF);
      m${i} = mNew;
      var sum = 0.0;
${$(c,f=>`      let p${f} = select(exp(${w(i,f)} - mNew), 0.0, ${w(i,f)} == NEG_INF);
      ${w(i,f)} = p${f};
      sum += p${f};`)}
      l${i} = l${i} * rs${i};
      red[(row0 + ${i}u) * ${l}u + tx] = sum;
    }`)}
${$(n,i=>$(b/4,f=>`    acc[${i*(b/4)+f}] *= vec4<f32>(rs${i});`))}
    workgroupBarrier();
${$(n,i=>`    for (var t = 0u; t < ${l}u; t++) { l${i} += red[(row0 + ${i}u) * ${l}u + t]; }`)}`}
${`
    // --- O[br, 64] += P[br, bc] V[bc, 64], bk keys at a time ----------------
    for (var cs = 0u; cs < ${s}u; cs += ${a}u) {
      workgroupBarrier();
      if (tx * ${c}u >= cs && tx * ${c}u < cs + ${a}u) {
        let kc = tx * ${c}u - cs;
${$(n,i=>$(c,f=>`        SA[(kc + ${f}u) * ${u/4}u + ((row0 + ${i}u) >> 2u)][(row0 + ${i}u) & 3u] = s[${i*(c/4)+(f>>2)}][${f&3}];`))}
      }
      for (var li = lid; li < ${a*g/4}u; li += ${h}u) {
        let lkey = li / ${g/4}u;
        let ld = (li % ${g/4}u) * 4u;
        let key = c0 + cs + lkey;
        var v = vec4<f32>(0.0);
        if (key < P.S) {
          let o = vBase + ${z}key * P.ldv + ld;
          v = vec4<f32>(${d}[o], ${d}[o + 1u], ${d}[o + 2u], ${d}[o + 3u]);
        }
        SB[lkey * ${g/4}u + (ld >> 2u)] = v;
      }
      workgroupBarrier();
      for (var k = 0u; k < ${a}u; k++) {
${$(n/4,i=>`        let a${i} = SA[k * ${u/4}u + ty * ${n/4}u + ${i}u];`)}
${$(b/4,i=>`        let v${i} = SB[k * ${g/4}u + tx * ${b/4}u + ${i}u];`)}
${$(n,i=>$(b/4,f=>`        acc[${i*(b/4)+f}] += vec4<f32>(a${Math.floor(i/4)}[${i%4}]) * v${f};`))}
      }
    }`}
  }


${$(n,i=>`  {
    let qrow = q0 + row0 + ${i}u;
    if (qrow < P.T) {
      let norm = 1.0 / max(l${i}, 1e-20);
      let o = oBase + qrow * P.ldo + tx * ${b}u;
${$(b/4,f=>`      let out${f} = acc[${i*(b/4)+f}] * norm;
      O[o + ${f*4}u] = out${f}.x; O[o + ${f*4+1}u] = out${f}.y;
      O[o + ${f*4+2}u] = out${f}.z; O[o + ${f*4+3}u] = out${f}.w;`)}
    }
  }`)}
}`}const re=t=>t==="q8"||t==="q5"||t==="q4";function S(t){let e=1;for(const r of t)e*=r;return e}function ue(t){switch(t){case"f32":case"u32":case"i32":return 4;case"f16":return 2;case"q8":case"q5":case"q4":return T[t]/P}}function G(t,e){const r=S(t);if(re(e)){if(r%P!==0)throw new Error(`${e} tensor size ${r} is not a multiple of ${P}`);return r/P*T[e]}return r*ue(e)}const P=32,se=36,oe=20,ie=24,T={q8:se,q5:ie,q4:oe},C=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;class K{constructor(e){this.device=e}free=new Map;live=new Set;allocatedBytes=0;peakBytes=0;static bucket(e){if(e<=65536)return Math.ceil(e/256)*256;const o=2**(Math.floor(Math.log2(e))-3);return Math.ceil(e/o)*o}alloc(e,r,o=""){const u=G(e,r),s=K.bucket(u);let n=this.free.get(s)?.pop();return n||(n=this.device.createBuffer({size:s,usage:C,label:o}),this.allocatedBytes+=s,this.peakBytes=Math.max(this.peakBytes,this.allocatedBytes)),this.live.add(n),{buffer:n,shape:e,dtype:r,size:S(e),byteLength:u,label:o}}release(...e){for(const r of e){if(!r||!this.live.has(r.buffer))continue;this.live.delete(r.buffer);const o=r.buffer.size,u=this.free.get(o);u?u.push(r.buffer):this.free.set(o,[r.buffer])}}get bytes(){return this.allocatedBytes}get peak(){return this.peakBytes}destroy(){for(const e of this.free.values())for(const r of e)r.destroy();for(const e of this.live)e.destroy();this.free.clear(),this.live.clear(),this.allocatedBytes=0}}function Pe(t,e,r,o,u=""){const s=G(r,o);if(e.byteLength<s)throw new Error(`upload ${u}: got ${e.byteLength}B, need ${s}B for ${r}`);const a=Math.ceil(s/4)*4,n=t.createBuffer({size:a,usage:C,label:u});return t.queue.writeBuffer(n,0,e.buffer,e.byteOffset,s),{buffer:n,shape:r,dtype:o,size:S(r),byteLength:s,label:u}}async function xe(t,e,r=e.size,o=0){const u=Math.ceil(r/4)*4,s=t.createBuffer({size:u,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,label:"readback"}),a=t.createCommandEncoder({label:"readback"});a.copyBufferToBuffer(e,o,s,0,u),t.queue.submit([a.finish()]),await s.mapAsync(GPUMapMode.READ);const n=s.getMappedRange().slice(0);return s.unmap(),s.destroy(),n}const Q=new Float32Array(1),ae=new Uint32Array(Q.buffer);function ne(t){Q[0]=t;const e=ae[0],r=e>>>23&255,o=e>>>12&2047;let u=e>>>16&32768;if(r===255)return u|31744|(e&8388607?512:0);if(r>142)return u|31744;if(r<103)return u;if(r<113){const s=o|2048;return u|(s>>>114-r)+(s>>>113-r&1)}return u|=r-112<<10|o>>>1,u+(o&1)}function Se(t){const e=new Uint16Array(t.length);for(let r=0;r<t.length;r++)e[r]=ne(t[r]);return e}export{N as A,K as B,x as G,g as H,ce as K,de as P,y as T,pe as a,$e as b,ve as c,fe as d,he as e,Se as f,Z as g,te as h,le as i,Be as j,ke as k,ye as l,ge as m,we as n,be as o,me as p,xe as r,J as t,Pe as u,_ as w};
