(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))u(o);new MutationObserver(o=>{for(const s of o)if(s.type==="childList")for(const a of s.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&u(a)}).observe(document,{childList:!0,subtree:!0});function r(o){const s={};return o.integrity&&(s.integrity=o.integrity),o.referrerPolicy&&(s.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?s.credentials="include":o.crossOrigin==="anonymous"?s.credentials="omit":s.credentials="same-origin",s}function u(o){if(o.ep)return;o.ep=!0;const s=r(o);fetch(o.href,s)}})();const Q=["maxBufferSize","maxStorageBufferBindingSize","maxComputeWorkgroupStorageSize","maxComputeInvocationsPerWorkgroup","maxComputeWorkgroupSizeX","maxStorageBuffersPerShaderStage","maxBindGroups"];async function oe(t={}){const e=globalThis.navigator?.gpu;if(!e)throw new Error("WebGPU is not available. Use Chrome/Edge 113+, Safari 18+, or Chrome on Android 121+.");const r=await e.requestAdapter({powerPreference:t.powerPreference??"high-performance"});if(!r)throw new Error("No WebGPU adapter found.");const u=[],o=r.features.has("shader-f16")&&!t.forceF32;o&&u.push("shader-f16");const s=r.features.has("timestamp-query");s&&u.push("timestamp-query");const a=r.features.has("subgroups");a&&u.push("subgroups");const n={},c=r.limits;for(const d of Q){const v=c[d];typeof v=="number"&&(n[d]=v)}const l=await r.requestDevice({requiredFeatures:u,requiredLimits:n,label:"whisper-gpu"});l.onuncapturederror=d=>{const v=d.error;t.onError?t.onError(v):console.error("[whisper-gpu] uncaptured GPU error:",v.message)};const b=r.info,h=l.limits,m={f16:o,timestampQuery:s,subgroups:a,maxBufferSize:h.maxBufferSize,maxStorageBufferBindingSize:h.maxStorageBufferBindingSize,maxComputeInvocationsPerWorkgroup:h.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupStorageSize:h.maxComputeWorkgroupStorageSize,maxStorageBuffersPerShaderStage:h.maxStorageBuffersPerShaderStage,vendor:b?.vendor??"",architecture:b?.architecture??"",description:b?.description??""};return{adapter:r,device:l,queue:l.queue,caps:m,lost:l.lost}}function se(t){return`${[t.vendor,t.architecture,t.description].filter(Boolean).join(" ")||"unknown adapter"} | f16=${t.f16} timestamps=${t.timestampQuery} maxBuffer=${t.maxBufferSize/1024/1024|0}MiB maxBinding=${t.maxStorageBufferBindingSize/1024/1024|0}MiB`}const p=256;class F{constructor(e,r=1024){this.device=e,this.buffer=e.createBuffer({size:r*p,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"uniform-arena"}),this.staging=new Uint8Array(p)}buffer;next=0;staging;alloc(e){const r=this.next*p;if(this.next++,e.byteLength>p)throw new Error(`uniform payload ${e.byteLength}B exceeds slot size ${p}B`);return this.write(r,e),r}write(e,r){this.staging.fill(0),this.staging.set(new Uint8Array(r.buffer,r.byteOffset,r.byteLength),0),this.device.queue.writeBuffer(this.buffer,e,this.staging,0,p)}reset(){this.next=0}destroy(){this.buffer.destroy()}}class ue{constructor(e){this.ctx=e,this.device=e.device,this.uniforms=new F(e.device)}device;uniforms;layouts=new Map;pipelines=new Map;modules=new Map;bindGroups=new Map;bufferIds=new WeakMap;nextBufferId=1;layoutFor(e,r){const u=`${e}:${r}`;let o=this.layouts.get(u);if(o)return o;const s=[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",hasDynamicOffset:!0}}];for(let a=0;a<e;a++)s.push({binding:1+a,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}});for(let a=0;a<r;a++)s.push({binding:1+e+a,visibility:GPUShaderStage.COMPUTE,buffer:{type:"read-only-storage"}});return o=this.device.createBindGroupLayout({entries:s,label:`layout-${u}`}),this.layouts.set(u,o),o}moduleFor(e,r){let u=this.modules.get(r);return u||(u=this.device.createShaderModule({code:r,label:e}),this.modules.set(r,u)),u}kernel(e){const r=`${e.name}|${e.entry??"main"}|${JSON.stringify(e.constants??{})}|${I(e.code)}`,u=this.pipelines.get(r);if(u)return u;const o=this.layoutFor(e.writes,e.reads),s=this.device.createComputePipeline({label:e.name,layout:this.device.createPipelineLayout({bindGroupLayouts:[o],label:`${e.name}-pl`}),compute:{module:this.moduleFor(e.name,e.code),entryPoint:e.entry??"main",constants:e.constants}}),a={spec:e,pipeline:s,layout:o};return this.pipelines.set(r,a),a}idOf(e){let r=this.bufferIds.get(e);return r===void 0&&(r=this.nextBufferId++,this.bufferIds.set(e,r)),r}bindGroup(e,r,u=p){const o=r.map(l=>"buffer"in l?l.buffer:l),s=`${e.spec.name}:${e.layout.label}:${o.map(l=>this.idOf(l)).join(",")}`,a=this.bindGroups.get(s);if(a)return a;const n=[{binding:0,resource:{buffer:this.uniforms.buffer,offset:0,size:u}}];o.forEach((l,b)=>n.push({binding:1+b,resource:{buffer:l}}));const c=this.device.createBindGroup({layout:e.layout,entries:n,label:s});return this.bindGroups.set(s,c),c}destroy(){this.uniforms.destroy(),this.pipelines.clear(),this.bindGroups.clear(),this.modules.clear()}}class ie{constructor(e,r=512){this.capacity=r,this.querySet=e.createQuerySet({type:"timestamp",count:r*2});const u=r*2*8;this.resolved=e.createBuffer({size:u,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,label:"profile-resolve"}),this.readback=e.createBuffer({size:u,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,label:"profile-readback"})}querySet;resolved;readback;labels=[];slot=0;totals=new Map;claim(e){if(this.slot>=this.capacity)return null;const r=this.slot++;return this.labels.push(e),{querySet:this.querySet,beginningOfPassWriteIndex:r*2,endOfPassWriteIndex:r*2+1}}resolve(e){this.slot!==0&&(e.resolveQuerySet(this.querySet,0,this.slot*2,this.resolved,0),e.copyBufferToBuffer(this.resolved,0,this.readback,0,this.slot*2*8))}async collect(){if(this.slot===0)return;await this.readback.mapAsync(GPUMapMode.READ,0,this.slot*2*8);const e=new BigUint64Array(this.readback.getMappedRange(0,this.slot*2*8).slice(0));this.readback.unmap();for(let r=0;r<this.slot;r++){if(e[r*2+1]===0n&&e[r*2]===0n)continue;const u=Number(e[r*2+1]-e[r*2])/1e6,o=this.labels[r].replace(/\.\d+\./,".*."),s=this.totals.get(o)??{ms:0,calls:0};s.ms+=u,s.calls++,this.totals.set(o,s)}this.slot=0,this.labels=[]}report(){return[...this.totals].map(([e,r])=>({label:e,ms:r.ms,calls:r.calls})).sort((e,r)=>r.ms-e.ms)}destroy(){this.querySet.destroy(),this.resolved.destroy(),this.readback.destroy()}}class ae{constructor(e="graph"){this.label=e}nodes=[];cuts=[];add(e){return this.nodes.push(e),e}cut(){const e=this.nodes.length;e>0&&this.cuts[this.cuts.length-1]!==e&&this.cuts.push(e)}chunks(e=1){const r=[0,...this.cuts];r[r.length-1]!==this.nodes.length&&r.push(this.nodes.length);const u=[];for(let o=0;o<r.length-1;o+=e)u.push([r[o],r[Math.min(o+e,r.length-1)]]);return u}encode(e,r,u){const[o,s]=r??[0,this.nodes.length];if(u){for(let c=o;c<s;c++){const l=this.nodes[c],b=u.claim(l.label),h=e.beginComputePass(b?{label:l.label,timestampWrites:b}:{label:l.label});h.setPipeline(l.pipeline),h.setBindGroup(0,l.bindGroup,[l.uniformOffset]),h.dispatchWorkgroups(l.wg[0],l.wg[1],l.wg[2]),h.end()}return}const a=e.beginComputePass({label:this.label});let n=null;for(let c=o;c<s;c++){const l=this.nodes[c];l.pipeline!==n&&(a.setPipeline(l.pipeline),n=l.pipeline),a.setBindGroup(0,l.bindGroup,[l.uniformOffset]),a.dispatchWorkgroups(l.wg[0],l.wg[1],l.wg[2])}a.end()}}function I(t){let e=5381;for(let r=0;r<t.length;r++)e=(e<<5)+e+t.charCodeAt(r)|0;return e>>>0}function V(t,e){return`
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
}`}function M(t,e,r="f16"){return r==="q8"?W(t,e):V(t,e)}const _=`
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
}`,y={bm:64,bn:64,bk:16,tm:4,tn:4};y.bm;y.bn;y.bk;function N(t){return t.bm/t.tm*(t.bn/t.tn)}function D(t){return(t.bm+t.bn)*t.bk*4}function j(t){for(const[u,o]of Object.entries(t))if(!Number.isInteger(o)||o<=0)return`${u}=${o} must be a positive integer`;if(t.bm%t.tm||t.bn%t.tn)return"bm/bn must divide by tm/tn";if(t.bk%4)return"bk must be a multiple of 4";if(t.bm%4||t.bn%4)return"bm/bn must be multiples of 4";if(t.tm%4||t.tn%4)return"tm/tn must be multiples of 4";const e=N(t);if(e>256)return`${e} invocations exceeds the 256 default limit`;const r=D(t);return r>16384?`${r}B workgroup storage exceeds the 16KiB default limit`:null}function ne(t){return new Uint32Array([t.M,t.N,t.K,t.lda??t.K,t.ldb??t.K,t.ldc??t.N,t.aOff??0,t.bOff??0,t.cOff??0,t.ldr??t.ldc??t.N,t.rOff??0,t.cin??0,t.stride??1,t.pad??0,t.tin??0,t.biasOff??0])}function le(t,e,r=y){return[Math.ceil(e/r.bn),Math.ceil(t/r.bm),1]}function A(t,e,r,u,o){const s=r/4,a=e*r/4,n=Math.ceil(a/u);let c="";for(let l=0;l<n;l++){const b=l===0?"lid":`lid + ${l*u}u`,h=a%u!==0&&l===n-1;c+=`
    {
      let li = ${b};
      ${h?`if (li < ${a}u) {`:""}
      let lrow = li / ${s}u;
      let lk = (li % ${s}u) * 4u;
      let kk = k0 + lk;
      ${o("lrow","kk","valid")}
      for (var t = 0u; t < 4u; t++) {
        ${t}[(lk + t) * ${e/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
      }
      ${h?"}":""}
    }`}return c}function fe(t,e=y){const r=j(e);if(r)throw new Error(`matmul tile ${JSON.stringify(e)}: ${r}`);const{bm:u,bn:o,bk:s,tm:a,tn:n}=e,c=N(e),l=4,b=(m,d)=>t.conv?`      let aRow = tileM + ${m};
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
${M(3,"B",t.weights)}
${t.bias?`@group(0) @binding(${l}) var<storage, read> bias: array<f32>;`:""}
${t.act==="gelu"?_:""}

var<workgroup> As: array<vec4<f32>, ${s*u/4}>;
var<workgroup> Bs: array<vec4<f32>, ${s*o/4}>;

@compute @workgroup_size(${c})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let tileN = wg.x * ${o}u;
  let tileM = wg.y * ${u}u;
  let tx = lid % ${o/n}u;   // output column group
  let ty = lid / ${o/n}u;   // output row group

  var acc: array<vec4<f32>, ${a*n/4}>;
  for (var i = 0u; i < ${a*n/4}u; i++) { acc[i] = vec4<f32>(0.0); }

  for (var k0 = 0u; k0 < P.K; k0 += ${s}u) {
    // Scatter into k-major tiles so the inner loop reads contiguous vec4s.
${A("As",u,s,c,b)}
${A("Bs",o,s,c,h)}
    workgroupBarrier();

    for (var k = 0u; k < ${s}u; k++) {
${Array.from({length:a/4},(m,d)=>`      let a${d} = As[k * ${u/4}u + ty * ${a/4}u + ${d}u];`).join(`
`)}
${Array.from({length:n/4},(m,d)=>`      let b${d} = Bs[k * ${o/4}u + tx * ${n/4}u + ${d}u];`).join(`
`)}
${Array.from({length:a},(m,d)=>Array.from({length:n/4},(v,P)=>`      acc[${d*(n/4)+P}] += vec4<f32>(a${Math.floor(d/4)}[${d%4}]) * b${P};`).join(`
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
}`}const x={gn:64,tk:4,rows:8},ce={gn:16,tk:8,rows:8};x.rows;function Y(t){return t.gn*t.tk}function J(t){return t.gn*t.tk*t.rows*4}function H(t){for(const u of["gn","tk","rows"]){const o=t[u];if(!Number.isInteger(o)||o<=0)return`${u}=${o} must be a positive integer`}if(t.tk&t.tk-1)return`tk=${t.tk} must be a power of two`;const e=Y(t);if(e>256)return`${e} invocations exceeds the 256 default limit`;const r=J(t);return r>16384?`${r}B workgroup storage exceeds the 16KiB default limit`:null}function de(t,e,r=x){return[Math.ceil(e/r.gn),1,1]}function be(t,e=x){const r=H(e);if(r)throw new Error(`gemv shape ${JSON.stringify(e)}: ${r}`);const{gn:u,tk:o,rows:s}=e,a=e.staticRows?`${s}u`:"rows";return`
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
${M(3,"B",t.weights)}
${t.bias?"@group(0) @binding(4) var<storage, read> bias: array<f32>;":""}
${t.act==="gelu"?_:""}

var<workgroup> red: array<f32, ${u*o*s}>;

@compute @workgroup_size(${u*o})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let col = lid / ${o}u;
  let lane = lid % ${o}u;
  let n = wg.x * ${u}u + col;
  // Out-of-range columns still run: every lane has to reach the barriers below.
  let live = n < P.N;
${e.staticRows?"":`  // Uniform across the workgroup, so the partial-sum slots each lane touches
  // line up with its reduction partner's.
  let rows = min(P.M, ${s}u);
`}
  var acc: array<f32, ${s}>;
  for (var m = 0u; m < ${s}u; m++) { acc[m] = 0.0; }

  let bBase = P.bOff + select(0u, n * P.ldb, live);
  for (var k = lane * 4u; k < P.K; k += ${o*4}u) {
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
  for (var s = ${o/2}u; s > 0u; s >>= 1u) {
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
}`}const g=64,U={br:16,bc:64,bk:32,tm:4,tn:4},$e={br:4,bc:64,bk:16,tm:4,tn:4};function k(t){return t.bc/t.tn}function q(t){return g/k(t)}function E(t){return t.br/t.tm*k(t)}function X(t){const e=t.bk*t.br,r=t.bk*Math.max(t.bc,g);return(e+r+t.br*k(t))*4}function Z(t){for(const[o,s]of Object.entries(t))if(!Number.isInteger(s)||s<=0)return`${o}=${s} must be a positive integer`;if(t.br%t.tm||t.bc%t.tn)return"br/bc must divide by tm/tn";if(t.tm%4||t.tn%4)return"tm/tn must be multiples of 4";if(t.bk%4)return"bk must be a multiple of 4";if(g%t.bk)return`bk must divide head_dim ${g}`;if(t.bc%t.bk||t.bk%t.tn)return"bk must divide bc and be a multiple of tn";const e=k(t);if(g%e||q(t)%4)return`bc/tn=${e} must divide head_dim ${g} into multiples of 4`;const r=E(t);if(r>256)return`${r} invocations exceeds the 256 default limit`;const u=X(t);return u>16384?`${u}B workgroup storage exceeds the 16KiB default limit`:null}function he(t,e=U){return[Math.ceil(t.T/e.br),t.heads,t.batch]}function ge(t,e,r={}){const u=new ArrayBuffer(96),o=new Uint32Array(u),s=new Float32Array(u);return o[0]=t.T,o[1]=t.S,o[2]=t.heads,o[3]=e.ldq,o[4]=e.ldk,o[5]=e.ldv,o[6]=e.ldo,o[7]=e.offQ??0,o[8]=e.offK??0,o[9]=e.offV??0,o[10]=e.offO??0,o[11]=e.bsQ??0,o[12]=e.bsK??0,o[13]=e.bsV??0,o[14]=e.bsO??0,o[15]=e.hsQ??g,o[16]=e.hsK??g,o[17]=e.hsV??g,o[18]=e.hsO??g,o[19]=r.qPos??0,o[20]=r.causal?1:0,s[21]=r.scale??1/Math.sqrt(g),new Uint8Array(u)}const $=(t,e)=>Array.from({length:t},(r,u)=>e(u)).join(`
`);function me(t=!0,e=!1,r=U){const u=Z(r);if(u)throw new Error(`attention tile ${JSON.stringify(r)}: ${u}`);const{br:o,bc:s,bk:a,tm:n,tn:c}=r,l=k(r),b=q(r),h=E(r),m=t?"K":"Q",d=t?"V":"Q",v=t?5:3,P=e?"path[b * P.S + key] * P.bsK + ":"",R=e?"path[b * P.S + key] * P.bsV + ":"",w=(i,f)=>`s[${i*(c/4)+(f>>2)}][${f&3}]`,O=a*o/4,L=a*Math.max(s,g)/4;return`
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
var<workgroup> red: array<f32, ${o*l}>;

const NEG_INF: f32 = -3.0e38;

@compute @workgroup_size(${h})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let q0 = wg.x * ${o}u;
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
          SA[(lk + t) * ${o/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      for (var li = lid; li < ${s*a/4}u; li += ${h}u) {
        let lrow = li / ${a/4}u;
        let lk = (li % ${a/4}u) * 4u;
        let key = c0 + lrow;
        var v = vec4<f32>(0.0);
        if (key < P.S) {
          let o = kBase + ${P}key * P.ldk + ks + lk;
          v = vec4<f32>(${m}[o], ${m}[o + 1u], ${m}[o + 2u], ${m}[o + 3u]);
        }
        for (var t = 0u; t < 4u; t++) {
          SB[(lk + t) * ${s/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      workgroupBarrier();
      for (var k = 0u; k < ${a}u; k++) {
${$(n/4,i=>`        let a${i} = SA[k * ${o/4}u + ty * ${n/4}u + ${i}u];`)}
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
${$(n,i=>$(c,f=>`        SA[(kc + ${f}u) * ${o/4}u + ((row0 + ${i}u) >> 2u)][(row0 + ${i}u) & 3u] = s[${i*(c/4)+(f>>2)}][${f&3}];`))}
      }
      for (var li = lid; li < ${a*g/4}u; li += ${h}u) {
        let lkey = li / ${g/4}u;
        let ld = (li % ${g/4}u) * 4u;
        let key = c0 + cs + lkey;
        var v = vec4<f32>(0.0);
        if (key < P.S) {
          let o = vBase + ${R}key * P.ldv + ld;
          v = vec4<f32>(${d}[o], ${d}[o + 1u], ${d}[o + 2u], ${d}[o + 3u]);
        }
        SB[lkey * ${g/4}u + (ld >> 2u)] = v;
      }
      workgroupBarrier();
      for (var k = 0u; k < ${a}u; k++) {
${$(n/4,i=>`        let a${i} = SA[k * ${o/4}u + ty * ${n/4}u + ${i}u];`)}
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
}`}function S(t){let e=1;for(const r of t)e*=r;return e}function ee(t){switch(t){case"f32":case"u32":case"i32":return 4;case"f16":return 2;case"q8":return T/B}}function G(t,e){const r=S(t);if(e==="q8"){if(r%B!==0)throw new Error(`q8 tensor size ${r} is not a multiple of ${B}`);return r/B*T}return r*ee(e)}const B=32,T=36,C=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;class K{constructor(e){this.device=e}free=new Map;live=new Set;allocatedBytes=0;peakBytes=0;static bucket(e){if(e<=65536)return Math.ceil(e/256)*256;const u=2**(Math.floor(Math.log2(e))-3);return Math.ceil(e/u)*u}alloc(e,r,u=""){const o=G(e,r),s=K.bucket(o);let n=this.free.get(s)?.pop();return n||(n=this.device.createBuffer({size:s,usage:C,label:u}),this.allocatedBytes+=s,this.peakBytes=Math.max(this.peakBytes,this.allocatedBytes)),this.live.add(n),{buffer:n,shape:e,dtype:r,size:S(e),byteLength:o,label:u}}release(...e){for(const r of e){if(!r||!this.live.has(r.buffer))continue;this.live.delete(r.buffer);const u=r.buffer.size,o=this.free.get(u);o?o.push(r.buffer):this.free.set(u,[r.buffer])}}get bytes(){return this.allocatedBytes}get peak(){return this.peakBytes}destroy(){for(const e of this.free.values())for(const r of e)r.destroy();for(const e of this.live)e.destroy();this.free.clear(),this.live.clear(),this.allocatedBytes=0}}function ve(t,e,r,u,o=""){const s=G(r,u);if(e.byteLength<s)throw new Error(`upload ${o}: got ${e.byteLength}B, need ${s}B for ${r}`);const a=Math.ceil(s/4)*4,n=t.createBuffer({size:a,usage:C,label:o});return t.queue.writeBuffer(n,0,e.buffer,e.byteOffset,s),{buffer:n,shape:r,dtype:u,size:S(r),byteLength:s,label:o}}async function pe(t,e,r=e.size,u=0){const o=Math.ceil(r/4)*4,s=t.createBuffer({size:o,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,label:"readback"}),a=t.createCommandEncoder({label:"readback"});a.copyBufferToBuffer(e,u,s,0,o),t.queue.submit([a.finish()]),await s.mapAsync(GPUMapMode.READ);const n=s.getMappedRange().slice(0);return s.unmap(),s.destroy(),n}const z=new Float32Array(1),te=new Uint32Array(z.buffer);function re(t){z[0]=t;const e=te[0],r=e>>>23&255,u=e>>>12&2047;let o=e>>>16&32768;if(r===255)return o|31744|(e&8388607?512:0);if(r>142)return o|31744;if(r<103)return o;if(r<113){const s=u|2048;return o|(s>>>114-r)+(s>>>113-r&1)}return o|=r-112<<10|u>>>1,o+(u&1)}function we(t){const e=new Uint16Array(t.length);for(let r=0;r<t.length;r++)e[r]=re(t[r]);return e}export{U as A,K as B,x as G,g as H,ue as K,ie as P,y as T,be as a,ne as b,de as c,se as d,le as e,we as f,H as g,Z as h,oe as i,me as j,ge as k,he as l,fe as m,$e as n,ae as o,ce as p,pe as r,j as t,ve as u,M as w};
