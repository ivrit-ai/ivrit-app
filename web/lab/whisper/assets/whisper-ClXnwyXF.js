import{u as Tt,o as X,H as v,w as tt,m as Mt,b as Q,e as ht,G as et,a as St,c as _t,A as Bt,j as At,k as Nt,l as Et,p as ft,r as Ft,B as qt,K as Ot}from"./tensor-Cc7Awdq-.js";class me{constructor(e,t={}){this.base=e,this.opts=t}url(e){return`${this.base.replace(/\/$/,"")}/${e}`}async manifest(){const e=await fetch(this.url("manifest.json"));if(!e.ok)throw new Error(`manifest: HTTP ${e.status}`);return await e.json()}async tokenizer(){const e=await fetch(this.url("tokenizer.json"));if(!e.ok)throw new Error(`tokenizer: HTTP ${e.status}`);return await e.json()}async shard(e){const t=this.url(e);if(this.opts.cache!==!1&&typeof caches<"u"){const r=await caches.open("whisper-gpu-weights"),n=await r.match(t);if(n)return await n.arrayBuffer();const i=await fetch(t);if(!i.ok)throw new Error(`${e}: HTTP ${i.status}`);return await r.put(t,i.clone()),await i.arrayBuffer()}const s=await fetch(t);if(!s.ok)throw new Error(`${e}: HTTP ${s.status}`);return await s.arrayBuffer()}}class Ut{constructor(e){this.manifest=e}tensors=new Map;bytes=0;get(e){const t=this.tensors.get(e);if(!t)throw new Error(`missing tensor: ${e}`);return t}has(e){return this.tensors.has(e)}destroy(){for(const e of this.tensors.values())e.buffer.destroy();this.tensors.clear()}}async function Gt(a,e,t){const s=await e.manifest();if(!s.format.startsWith("whisper-gpu-v1"))throw new Error(`unsupported model format: ${s.format}`);const r=new Ut(s),n=s.shards.reduce((d,u)=>d+u.bytes,0);let i=0;const c=s.shards.map(()=>[]),l=new Map;for(const[d,u]of Object.entries(s.tensors))c[u.shard].push(u),l.set(u,d);for(let d=0;d<s.shards.length;d++){const u=await e.shard(s.shards[d].file);for(const p of c[d]){const b=l.get(p),y=p.dtype==="f32"?new Float32Array(u,p.offset,p.bytes/4):p.dtype==="q8"||p.dtype==="q5"||p.dtype==="q4"?new Uint8Array(u,p.offset,p.bytes):new Uint16Array(u,p.offset,p.bytes/2);r.tensors.set(b,Tt(a.device,y,p.shape,p.dtype,b)),r.bytes+=p.bytes}i+=s.shards[d].bytes,t?.({loadedBytes:i,totalBytes:n,shard:d+1,shards:s.shards.length})}return r}const F=256;function It(){return`
struct Params {
  nFrames: u32, nSamples: u32, nFFT: u32, hop: u32,
  nMel: u32, nFreq: u32, pad0: u32, pad1: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> mel: array<f32>;
@group(0) @binding(2) var<storage, read_write> partialMax: array<f32>;
@group(0) @binding(3) var<storage, read> audio: array<f32>;
@group(0) @binding(4) var<storage, read> filters: array<f32>;

var<workgroup> xs: array<f32, 400>;
var<workgroup> tw: array<vec2<f32>, 400>;
var<workgroup> pw: array<f32, 201>;
var<workgroup> red: array<f32, ${F}>;

const TAU: f32 = 6.283185307179586;

/** torch.stft(center=true, pad_mode="reflect") index mapping. */
fn reflect(i: i32, n: i32) -> i32 {
  var x = i;
  if (x < 0) { x = -x; }
  if (x >= n) { x = 2 * n - 2 - x; }
  return clamp(x, 0, n - 1);
}

@compute @workgroup_size(${F})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let frame = wg.x;
  if (frame >= P.nFrames) { return; }

  // e^{-2*pi*i*j/N} for j = 0..N-1; the DFT phase for (k,n) is j = k*n mod N.
  for (var j = lid; j < P.nFFT; j += ${F}u) {
    let ang = -TAU * f32(j) / f32(P.nFFT);
    tw[j] = vec2<f32>(cos(ang), sin(ang));
  }
  let start = i32(frame * P.hop) - i32(P.nFFT / 2u);
  for (var n = lid; n < P.nFFT; n += ${F}u) {
    let s = audio[u32(reflect(start + i32(n), i32(P.nSamples)))];
    let w = 0.5 - 0.5 * cos(TAU * f32(n) / f32(P.nFFT)); // periodic Hann
    xs[n] = s * w;
  }
  workgroupBarrier();

  for (var k = lid; k < P.nFreq; k += ${F}u) {
    var re = 0.0;
    var im = 0.0;
    var j = 0u;
    for (var n = 0u; n < P.nFFT; n++) {
      let t = tw[j];
      re += xs[n] * t.x;
      im += xs[n] * t.y;
      j += k;
      if (j >= P.nFFT) { j -= P.nFFT; }
    }
    pw[k] = re * re + im * im;
  }
  workgroupBarrier();

  var localMax = -1.0e30;
  for (var m = lid; m < P.nMel; m += ${F}u) {
    var acc = 0.0;
    for (var k = 0u; k < P.nFreq; k++) {
      acc += filters[m * P.nFreq + k] * pw[k];
    }
    let v = log(max(acc, 1e-10)) * 0.4342944819032518; // log10
    mel[frame * P.nMel + m] = v;
    localMax = max(localMax, v);
  }
  red[lid] = localMax;
  workgroupBarrier();
  for (var s = ${F/2}u; s > 0u; s >>= 1u) {
    if (lid < s) { red[lid] = max(red[lid], red[lid + s]); }
    workgroupBarrier();
  }
  if (lid == 0u) { partialMax[frame] = red[0]; }
}`}function Kt(){return`
struct Params { nFrames: u32, nMel: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> mel: array<f32>;
@group(0) @binding(2) var<storage, read> partialMax: array<f32>;

var<workgroup> red: array<f32, ${F}>;
var<workgroup> gmax: f32;

@compute @workgroup_size(${F})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  var m = -1.0e30;
  for (var i = lid; i < P.nFrames; i += ${F}u) { m = max(m, partialMax[i]); }
  red[lid] = m;
  workgroupBarrier();
  for (var s = ${F/2}u; s > 0u; s >>= 1u) {
    if (lid < s) { red[lid] = max(red[lid], red[lid + s]); }
    workgroupBarrier();
  }
  if (lid == 0u) { gmax = red[0] - 8.0; }
  workgroupBarrier();
  // Every workgroup redundantly reduces the 3000 per-frame maxima (12 reads
  // each) so the clamp needs no second dispatch.
  let i = wg.x * ${F}u + lid;
  if (i < P.nFrames * P.nMel) {
    mel[i] = (max(mel[i], gmax) + 4.0) * 0.25;
  }
}`}function dt(a){return new Uint32Array([a.nFrames,a.nSamples,a.nFFT,a.hop,a.nMel,a.nFreq,0,0])}function pt(a,e){return new Uint32Array([a,e,0,0])}const Y={sampleRate:16e3,nFFT:400,hopLength:160,nSamples:48e4,nFrames:3e3,nMel:128};class Dt{constructor(e,t,s,r,n=Y.nSamples,i=Y){this.ctx=e,this.kernels=t,this.filters=s,this.maxSamples=n,this.cfg=i;const c=i.nFFT/2+1,l=Math.floor(n/i.hopLength)+i.nFrames;this.frames=i.nFrames,this.audioBuf=e.device.createBuffer({size:n*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,label:"audio"}),this.output=r.alloc([l,i.nMel],"f32","mel"),this.partialMax=r.alloc([l],"f32","mel-max");const d=t.kernel({name:"mel",code:It(),writes:2,reads:2}),u=t.kernel({name:"mel-normalize",code:Kt(),writes:1,reads:1});this.graph=new X("mel"),this.dft=this.graph.add({label:"mel-dft",pipeline:d.pipeline,bindGroup:t.bindGroup(d,[this.output,this.partialMax,this.audioBuf,this.filters]),uniformOffset:t.uniforms.alloc(dt({nFrames:i.nFrames,nSamples:i.nSamples,nFFT:i.nFFT,hop:i.hopLength,nMel:i.nMel,nFreq:c})),wg:[i.nFrames,1,1]}),this.normalize=this.graph.add({label:"mel-normalize",pipeline:u.pipeline,bindGroup:t.bindGroup(u,[this.output,this.partialMax]),uniformOffset:t.uniforms.alloc(pt(i.nFrames,i.nMel)),wg:[Math.ceil(i.nFrames*i.nMel/F),1,1]})}audioBuf;partialMax;graph;dft;normalize;output;frames;upload(e){const t=this.cfg,s=Math.min(e.length,this.maxSamples);this.ctx.queue.writeBuffer(this.audioBuf,0,e.buffer,e.byteOffset,s*4),this.frames=Math.max(1,Math.floor(s/t.hopLength));const r=t.nFFT/2+1;this.kernels.uniforms.write(this.dft.uniformOffset,dt({nFrames:this.frames,nSamples:s,nFFT:t.nFFT,hop:t.hopLength,nMel:t.nMel,nFreq:r})),this.dft.wg[0]=this.frames,this.kernels.uniforms.write(this.normalize.uniformOffset,pt(this.frames,t.nMel)),this.normalize.wg[0]=Math.ceil(this.frames*t.nMel/F);const n=new Float32Array(t.nFrames*t.nMel);this.ctx.queue.writeBuffer(this.output.buffer,this.frames*t.nMel*4,n)}encode(e){this.graph.encode(e)}}const V={br:8,bc:64,bk:32,tm:4,tn:4},W=v+2,vt=1200;function H(a,e,t=V){const s=Math.ceil(a/t.bc),r=Math.max(1,Math.min(32,Math.floor(vt/Math.max(e,1)))),n=Math.max(1,Math.min(s,r));return{nSl:n,slLen:Math.ceil(a/n)}}function st(a,e,t=V){return[e,a.heads,a.batch*Math.ceil(a.T/t.br)]}function rt(a,e,t,s,r){const n=new ArrayBuffer(96),i=new Uint32Array(n),c=new Float32Array(n);return i[0]=a.T,i[1]=a.S,i[2]=a.heads,i[3]=s.nSl,i[4]=s.slLen,i[5]=r,i[6]=e.ldq,i[7]=e.ldk,i[8]=e.ldv,i[9]=e.offQ??0,i[10]=e.offK??0,i[11]=e.offV??0,i[12]=e.bsQ??0,i[13]=e.bsK??0,i[14]=e.bsV??0,i[15]=e.hsQ??v,i[16]=e.hsK??v,i[17]=e.hsV??v,i[18]=t.qPos??0,i[19]=t.causal?1:0,c[20]=t.scale??1/Math.sqrt(v),new Uint8Array(n)}function it(a){const e=new Uint32Array(8);return e[0]=a.qTot,e[1]=a.heads,e[2]=a.nSl,e[3]=a.T,e[4]=a.layout.offO??0,e[5]=a.layout.bsO??0,e[6]=a.layout.ldo,e[7]=a.layout.hsO??v,new Uint8Array(e.buffer)}function nt(a,e){return[a*e,1,1]}const T=(a,e)=>Array.from({length:a},(t,s)=>e(s)).join(`
`);function Lt(a,e=V){const{br:t,bc:s,bk:r,tm:n,tn:i}=e,c=e.bc/e.tn,l=v/c,d=e.br/e.tm*c,u=a?"path[b * P.S + key] * P.bsK + ":"",p=a?"path[b * P.S + key] * P.bsV + ":"",b=(o,f)=>`s[${o*(i/4)+(f>>2)}][${f&3}]`,y=r*t/4,P=r*Math.max(s,v)/4;return`
struct Params {
  T: u32, S: u32, H: u32,
  nSl: u32, slLen: u32, qTot: u32,
  ldq: u32, ldk: u32, ldv: u32,
  offQ: u32, offK: u32, offV: u32,
  bsQ: u32, bsK: u32, bsV: u32,
  hsQ: u32, hsK: u32, hsV: u32,
  qPos: u32, causal: u32, scale: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> part: array<f32>;
@group(0) @binding(2) var<storage, read> Q: array<f32>;
@group(0) @binding(3) var<storage, read> K: array<f32>;
@group(0) @binding(4) var<storage, read> V: array<f32>;
${a?"@group(0) @binding(5) var<storage, read> path: array<u32>;":""}

var<workgroup> SA: array<vec4<f32>, ${y}>;
var<workgroup> SB: array<vec4<f32>, ${P}>;
var<workgroup> red: array<f32, ${t*c}>;

const NEG_INF: f32 = -3.0e38;

@compute @workgroup_size(${d})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let slice = wg.x;
  let h = wg.y;
  let qTiles = (P.T + ${t-1}u) / ${t}u;
  let qt = wg.z % qTiles;
  let b = wg.z / qTiles;
  let q0 = qt * ${t}u;
  let sBegin = slice * P.slLen;
  let sEnd = min(P.S, sBegin + P.slLen);
  let ty = lid / ${c}u;   // query row group
  let tx = lid % ${c}u;   // key group during QK^T, head-dim group during PV
  let row0 = ty * ${n}u;    // first query row this thread owns, within the block

  let qBase = P.offQ + b * P.bsQ + h * P.hsQ;
  let kBase = P.offK + h * P.hsK + ${a?"0u":"b * P.bsK"};
  let vBase = P.offV + h * P.hsV + ${a?"0u":"b * P.bsV"};

  var acc: array<vec4<f32>, ${n*l/4}>;
${T(n*l/4,o=>`  acc[${o}] = vec4<f32>(0.0);`)}
  var s: array<vec4<f32>, ${n*i/4}>;
${T(n,o=>`  var m${o} = NEG_INF; var l${o} = 0.0; var rs${o} = 0.0;`)}

  for (var c0 = sBegin; c0 < sEnd; c0 += ${s}u) {
${T(n*i/4,o=>`    s[${o}] = vec4<f32>(0.0);`)}

    // --- scores: S[br, bc] = (scale * Q[br, 64]) K[bc, 64]^T ----------------
    for (var ks = 0u; ks < ${v}u; ks += ${r}u) {
      workgroupBarrier();
      for (var li = lid; li < ${y}u; li += ${d}u) {
        let lrow = li / ${r/4}u;
        let lk = (li % ${r/4}u) * 4u;
        let qrow = q0 + lrow;
        var v = vec4<f32>(0.0);
        if (qrow < P.T) {
          let o = qBase + qrow * P.ldq + ks + lk;
          v = vec4<f32>(Q[o], Q[o + 1u], Q[o + 2u], Q[o + 3u]) * P.scale;
        }
        for (var t = 0u; t < 4u; t++) {
          SA[(lk + t) * ${t/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      for (var li = lid; li < ${s*r/4}u; li += ${d}u) {
        let lrow = li / ${r/4}u;
        let lk = (li % ${r/4}u) * 4u;
        let key = c0 + lrow;
        var v = vec4<f32>(0.0);
        if (key < sEnd) {
          let o = kBase + ${u}key * P.ldk + ks + lk;
          v = vec4<f32>(K[o], K[o + 1u], K[o + 2u], K[o + 3u]);
        }
        for (var t = 0u; t < 4u; t++) {
          SB[(lk + t) * ${s/4}u + (lrow >> 2u)][lrow & 3u] = v[t];
        }
      }
      workgroupBarrier();
      for (var k = 0u; k < ${r}u; k++) {
${T(n/4,o=>`        let a${o} = SA[k * ${t/4}u + ty * ${n/4}u + ${o}u];`)}
${T(i/4,o=>`        let b${o} = SB[k * ${s/4}u + tx * ${i/4}u + ${o}u];`)}
${T(n,o=>T(i/4,f=>`        s[${o*(i/4)+f}] += vec4<f32>(a${Math.floor(o/4)}[${o%4}]) * b${f};`))}
      }
    }

    // --- mask, then the running max over this block -------------------------
    workgroupBarrier(); // red still holds the previous block's sums
    let key0 = c0 + tx * ${i}u;
${T(n,o=>`    {
      let qp = P.qPos + q0 + row0 + ${o}u;
      var lm = NEG_INF;
${T(i,f=>`      let v${f} = select(NEG_INF, ${b(o,f)}, key0 + ${f}u < sEnd && (P.causal == 0u || key0 + ${f}u <= qp));
      ${b(o,f)} = v${f};
      lm = max(lm, v${f});`)}
      red[(row0 + ${o}u) * ${c}u + tx] = lm;
    }`)}
    workgroupBarrier();

    // --- online softmax: rescale the running state, exponentiate the block --
${T(n,o=>`    var bm${o} = NEG_INF;
    for (var t = 0u; t < ${c}u; t++) { bm${o} = max(bm${o}, red[(row0 + ${o}u) * ${c}u + t]); }`)}
    workgroupBarrier();
${T(n,o=>`    {
      let mNew = max(m${o}, bm${o});
      rs${o} = select(exp(m${o} - mNew), 0.0, m${o} == NEG_INF);
      m${o} = mNew;
      var sum = 0.0;
${T(i,f=>`      let p${f} = select(exp(${b(o,f)} - mNew), 0.0, ${b(o,f)} == NEG_INF);
      ${b(o,f)} = p${f};
      sum += p${f};`)}
      l${o} = l${o} * rs${o};
      red[(row0 + ${o}u) * ${c}u + tx] = sum;
    }`)}
${T(n,o=>T(l/4,f=>`    acc[${o*(l/4)+f}] *= vec4<f32>(rs${o});`))}
    workgroupBarrier();
${T(n,o=>`    for (var t = 0u; t < ${c}u; t++) { l${o} += red[(row0 + ${o}u) * ${c}u + t]; }`)}

    // --- O[br, 64] += P[br, bc] V[bc, 64], bk keys at a time ----------------
    for (var cs = 0u; cs < ${s}u; cs += ${r}u) {
      workgroupBarrier();
      if (tx * ${i}u >= cs && tx * ${i}u < cs + ${r}u) {
        let kc = tx * ${i}u - cs;
${T(n,o=>T(i,f=>`        SA[(kc + ${f}u) * ${t/4}u + ((row0 + ${o}u) >> 2u)][(row0 + ${o}u) & 3u] = s[${o*(i/4)+(f>>2)}][${f&3}];`))}
      }
      for (var li = lid; li < ${r*v/4}u; li += ${d}u) {
        let lkey = li / ${v/4}u;
        let ld = (li % ${v/4}u) * 4u;
        let key = c0 + cs + lkey;
        var v = vec4<f32>(0.0);
        if (key < sEnd) {
          let o = vBase + ${p}key * P.ldv + ld;
          v = vec4<f32>(V[o], V[o + 1u], V[o + 2u], V[o + 3u]);
        }
        SB[lkey * ${v/4}u + (ld >> 2u)] = v;
      }
      workgroupBarrier();
      for (var k = 0u; k < ${r}u; k++) {
${T(n/4,o=>`        let a${o} = SA[k * ${t/4}u + ty * ${n/4}u + ${o}u];`)}
${T(l/4,o=>`        let v${o} = SB[k * ${v/4}u + tx * ${l/4}u + ${o}u];`)}
${T(n,o=>T(l/4,f=>`        acc[${o*(l/4)+f}] += vec4<f32>(a${Math.floor(o/4)}[${o%4}]) * v${f};`))}
      }
    }
  }

  // Park the unnormalised state; the combine pass normalises across slices.
  // Every thread of a row group holds the same m/l after the reductions, so
  // one column group publishes the scalars.
${T(n,o=>`  {
    let qrow = q0 + row0 + ${o}u;
    if (qrow < P.T) {
      let pb = ((slice * P.qTot + b * P.T + qrow) * P.H + h) * ${W}u;
${T(l/4,f=>`      part[pb + tx * ${l}u + ${f*4}u] = acc[${o*(l/4)+f}].x;
      part[pb + tx * ${l}u + ${f*4+1}u] = acc[${o*(l/4)+f}].y;
      part[pb + tx * ${l}u + ${f*4+2}u] = acc[${o*(l/4)+f}].z;
      part[pb + tx * ${l}u + ${f*4+3}u] = acc[${o*(l/4)+f}].w;`)}
      if (tx == 0u) {
        part[pb + ${v}u] = m${o};
        part[pb + ${v+1}u] = l${o};
      }
    }
  }`)}
}`}function zt(){return`
struct Params {
  qTot: u32, H: u32, nSl: u32, T: u32,
  offO: u32, bsO: u32, ldo: u32, hsO: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<storage, read> part: array<f32>;

const NEG_INF: f32 = -3.0e38;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let gh = wg.x;
  let gq = gh / P.H;
  let h = gh % P.H;
  let base = (gq * P.H + h) * ${W}u;

  var M = NEG_INF;
  for (var s = 0u; s < P.nSl; s++) {
    M = max(M, part[(s * P.qTot) * P.H * ${W}u + base + ${v}u]);
  }
  var L = 0.0;
  for (var s = 0u; s < P.nSl; s++) {
    let pb = (s * P.qTot) * P.H * ${W}u + base;
    let m = part[pb + ${v}u];
    L += select(exp(m - M), 0.0, M <= NEG_INF) * part[pb + ${v+1}u];
  }

  var v = 0.0;
  for (var s = 0u; s < P.nSl; s++) {
    let pb = (s * P.qTot) * P.H * ${W}u + base;
    let m = part[pb + ${v}u];
    v += select(exp(m - M), 0.0, M <= NEG_INF) * part[pb + lid];
  }

  let b = gq / P.T;
  let qrow = gq % P.T;
  let o = P.offO + b * P.bsO + qrow * P.ldo + h * P.hsO + lid;
  O[o] = v / max(L, 1e-20);
}`}const K=256;function Vt(a=!1){const e=a?"Y":"X";return`
struct Params { M: u32, K: u32, lda: u32, ldc: u32, aOff: u32, cOff: u32, eps: f32, pad: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> Y: array<f32>;
${a?"":"@group(0) @binding(2) var<storage, read> X: array<f32>;"}
@group(0) @binding(${a?2:3}) var<storage, read> gamma: array<f32>;
@group(0) @binding(${a?3:4}) var<storage, read> beta: array<f32>;

var<workgroup> red: array<f32, ${K}>;
var<workgroup> red2: array<f32, ${K}>;
var<workgroup> mean_s: f32;
var<workgroup> rstd_s: f32;

@compute @workgroup_size(${K})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let row = wg.x;
  if (row >= P.M) { return; }
  let base = P.aOff + row * P.lda;

  var s = 0.0;
  var s2 = 0.0;
  for (var i = lid; i < P.K; i += ${K}u) {
    let v = ${e}[base + i];
    s += v;
    s2 += v * v;
  }
  red[lid] = s;
  red2[lid] = s2;
  workgroupBarrier();
  for (var stride = ${K/2}u; stride > 0u; stride >>= 1u) {
    if (lid < stride) {
      red[lid] += red[lid + stride];
      red2[lid] += red2[lid + stride];
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    let n = f32(P.K);
    let mean = red[0] / n;
    mean_s = mean;
    rstd_s = inverseSqrt(max(red2[0] / n - mean * mean, 0.0) + P.eps);
  }
  workgroupBarrier();

  let mean = mean_s;
  let rstd = rstd_s;
  let obase = P.cOff + row * P.ldc;
  for (var i = lid; i < P.K; i += ${K}u) {
    Y[obase + i] = (${e}[base + i] - mean) * rstd * gamma[i] + beta[i];
  }
}`}function ot(a){const e=new ArrayBuffer(32),t=new Uint32Array(e),s=new Float32Array(e);return t[0]=a.M,t[1]=a.K,t[2]=a.lda??a.K,t[3]=a.ldc??a.K,t[4]=a.aOff??0,t[5]=a.cOff??0,s[6]=a.eps??1e-5,new Uint8Array(e)}function Rt(a="f16",e=a){return`
struct Params { N: u32, D: u32, posBase: u32, ldc: u32, cOff: u32, beams: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> Y: array<f32>;
@group(0) @binding(2) var<storage, read> ids: array<u32>;
${tt(3,"tok",a)}
${tt(4,"pos",e)}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let d4 = gid.x;              // vec4 lane within the model dimension
  let row = gid.y;
  if (row >= P.N || d4 * 4u >= P.D) { return; }
  let t = ids[row];
  let e = tok_load4((t * P.D) / 4u + d4);
  let p = pos_load4(((P.posBase + row / P.beams) * P.D) / 4u + d4);
  let o = P.cOff + row * P.ldc + d4 * 4u;
  let v = e + p;
  Y[o] = v.x; Y[o + 1u] = v.y; Y[o + 2u] = v.z; Y[o + 3u] = v.w;
}`}function $t(a){return new Uint32Array([a.N,a.D,a.posBase,a.ldc??a.D,a.cOff??0,a.beams??1,0,0])}function Ct(a="f16"){return`
struct Params { N: u32, D: u32, rowBase: u32, ldc: u32, cOff: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> Y: array<f32>;
${tt(2,"tab",a)}

@compute @workgroup_size(${K})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let d4 = gid.x;
  let row = gid.y;
  if (row >= P.N || d4 * 4u >= P.D) { return; }
  let t = tab_load4(((P.rowBase + row) * P.D) / 4u + d4);
  let o = P.cOff + row * P.ldc + d4 * 4u;
  Y[o] += t.x; Y[o + 1u] += t.y; Y[o + 2u] += t.z; Y[o + 3u] += t.w;
}`}function C(a){return a.dtype==="q8"||a.dtype==="q5"||a.dtype==="q4"?a.dtype:"f16"}class at{constructor(e,t){this.kernels=e,this.graph=t}add(e,t,s,r,n,i,c,l){const d=this.kernels.kernel({name:t,code:s,writes:r,reads:n});return this.graph.add({label:e,pipeline:d.pipeline,bindGroup:this.kernels.bindGroup(d,c),uniformOffset:this.kernels.uniforms.alloc(i),wg:l})}matmul(e,t){const s={bias:!!t.bias,act:t.act??"none",accumulate:!!t.accumulate,conv:!!t.conv,weights:C(t.b)},r=[t.out,t.a,t.b];t.bias&&r.push(t.bias);const n=`matmul${s.conv?"-conv":""}${s.bias?"-b":""}${s.accumulate?"-acc":""}${s.act==="gelu"?"-gelu":""}${s.weights!=="f16"?`-${s.weights}`:""}`,i=this.add(e,n,Mt(s),1,r.length-1,Q({M:t.M,N:t.N,K:t.K,lda:t.lda,ldb:t.ldb,ldc:t.ldc,aOff:t.aOff,bOff:t.bOff,cOff:t.cOff,biasOff:t.biasOff,cin:t.conv?.cin,stride:t.conv?.stride,pad:t.conv?.pad,tin:t.conv?.tin}),r,ht(t.M,t.N));if(!s.conv){const c=t.gemv??et,l=this.kernels.kernel({name:`gemv-gn${c.gn}tk${c.tk}r${c.rows}${n.slice(6)}`,code:St(s,c),writes:1,reads:r.length-1});i.variants={wide:{pipeline:i.pipeline,bindGroup:i.bindGroup},skinny:{pipeline:l.pipeline,bindGroup:this.kernels.bindGroup(l,r),cfg:c}}}return i}tuneMatmul(e,t,s){const r=e.variants,n=r!==void 0&&t<=r.skinny.cfg.rows;if(r){const c=n?r.skinny:r.wide;e.pipeline=c.pipeline,e.bindGroup=c.bindGroup}const i=n?_t(t,s,r.skinny.cfg):ht(t,s);e.wg[0]=i[0],e.wg[1]=i[1],e.wg[2]=i[2]}layerNorm(e,t){const s=t.out.buffer===t.x.buffer;return this.add(e,s?"layernorm-inplace":"layernorm",Vt(s),1,s?2:3,ot(t),s?[t.out,t.weight,t.bias]:[t.out,t.x,t.weight,t.bias],[t.M,1,1])}attention(e,t){const s=!!t.k,r=t.config??Bt,n=[t.out,t.q];return t.k&&n.push(t.k),t.v&&n.push(t.v??t.k),t.path&&n.push(t.path),this.add(e,`${s?"flash-attn":"flash-attn-fused"}${t.path?"-gather":""}-${r.br}x${r.bc}x${r.bk}/${r.tm}x${r.tn}`,At(s,!!t.path,r),1,n.length-1,Nt(t.shape,t.layout,{causal:t.causal,qPos:t.qPos,scale:t.scale}),n,Et(t.shape,r))}attentionSplit(e,t){const s=!!t.path,r=[t.partial,t.q];t.k&&r.push(t.k),t.v&&r.push(t.v??t.k),t.path&&r.push(t.path);const n=`${V.br}x${V.bc}x${V.bk}/${V.tm}x${V.tn}`,i=t.shape.T*t.shape.batch,c=H(t.shape.S,i),l=this.add(`${e}.split`,`attn-split${s?"-gather":""}-${n}`,Lt(s),1,r.length-1,rt(t.shape,t.layout,{causal:t.causal,qPos:t.qPos,scale:t.scale},c,i),r,st(t.shape,c.nSl)),d=this.add(`${e}.combine`,"attn-combine",zt(),1,1,it({qTot:i,heads:t.shape.heads,nSl:c.nSl,T:t.shape.T,layout:t.layout}),[t.out,t.partial],nt(i,t.shape.heads));return{split:l,combine:d}}embed(e,t){return this.add(e,`embed-${C(t.tok)}${C(t.pos)}`,Rt(C(t.tok),C(t.pos)),1,3,$t(t),[t.out,t.ids,t.tok,t.pos],[Math.ceil(t.D/4/K)||1,t.N,1])}addTable(e,t){const s=new Uint32Array([t.N,t.D,t.rowBase??0,t.ldc??t.D,t.cOff??0,0,0,0]);return this.add(e,`add-table-${C(t.table)}`,Ct(C(t.table)),1,1,s,[t.out,t.table],[Math.ceil(t.D/4/K)||1,t.N,1])}}class Wt{constructor(e,t,s,r,n){this.ctx=e,this.kernels=t,this.weights=s;const i=s.manifest.config,c=i.n_audio_state,l=i.n_audio_ctx,d=s.manifest.audio.n_frames,u=i.n_audio_head,p=i.ffn_dim,b=g=>s.get(g);this.graph=new X("encoder");const y=new at(t,this.graph),P=r.alloc([d,c],"f32","enc.conv1"),o=r.alloc([l,c],"f32","enc.x"),f=r.alloc([l,c],"f32","enc.norm"),U=r.alloc([l,3*c],"f32","enc.qkv"),B=r.alloc([l,c],"f32","enc.attn"),x=r.alloc([l,p],"f32","enc.ffn");this.output=o,this.conv1=y.matmul("conv1",{out:P,a:n,b:b("encoder.conv1.weight"),bias:b("encoder.conv1.bias"),M:d,N:c,K:3*i.n_mels,act:"gelu",lda:i.n_mels,conv:{stride:1,pad:1,tin:d,cin:i.n_mels}}),y.matmul("conv2",{out:o,a:P,b:b("encoder.conv2.weight"),bias:b("encoder.conv2.bias"),M:l,N:c,K:3*c,act:"gelu",lda:c,conv:{stride:2,pad:1,tin:d,cin:c}}),y.addTable("encoder.pos_emb",{out:o,table:b("encoder.pos_emb"),N:l,D:c});for(let g=0;g<i.n_audio_layer;g++){const $=`encoder.blocks.${g}`;y.layerNorm(`${$}.ln1`,{out:f,x:o,weight:b(`${$}.ln1.weight`),bias:b(`${$}.ln1.bias`),M:l,K:c}),y.matmul(`${$}.qkv`,{out:U,a:f,b:b(`${$}.attn.qkv.weight`),bias:b(`${$}.attn.qkv.bias`),M:l,N:3*c,K:c}),y.attention(`${$}.attn`,{out:B,q:U,shape:{T:l,S:l,heads:u,batch:1},layout:{ldq:3*c,ldk:3*c,ldv:3*c,ldo:c,offK:c,offV:2*c,hsQ:v,hsK:v,hsV:v,hsO:v}}),y.matmul(`${$}.attn.out`,{out:o,a:B,b:b(`${$}.attn.out.weight`),bias:b(`${$}.attn.out.bias`),M:l,N:c,K:c,accumulate:!0}),y.layerNorm(`${$}.ln2`,{out:f,x:o,weight:b(`${$}.ln2.weight`),bias:b(`${$}.ln2.bias`),M:l,K:c}),y.matmul(`${$}.fc1`,{out:x,a:f,b:b(`${$}.mlp.fc1.weight`),bias:b(`${$}.mlp.fc1.bias`),M:l,N:p,K:c,act:"gelu"}),y.matmul(`${$}.fc2`,{out:o,a:x,b:b(`${$}.mlp.fc2.weight`),bias:b(`${$}.mlp.fc2.bias`),M:l,N:c,K:p,accumulate:!0}),this.graph.cut()}y.layerNorm("encoder.ln_post",{out:o,x:o,weight:b("encoder.ln_post.weight"),bias:b("encoder.ln_post.bias"),M:l,K:c}),r.release(P,f,U,B,x)}graph;output;conv1;setWindow(e){const t=this.weights.manifest.config,s=this.weights.manifest.audio.n_frames;this.kernels.uniforms.write(this.conv1.uniformOffset,Q({M:s,N:t.n_audio_state,K:3*t.n_mels,lda:t.n_mels,aOff:e*t.n_mels,cin:t.n_mels,stride:1,pad:1,tin:s}))}async run(e=1,t){for(const s of this.graph.chunks(e)){const r=this.ctx.device.createCommandEncoder();this.graph.encode(r,s,t),t?.resolve(r),this.ctx.queue.submit([r.finish()]),await this.ctx.queue.onSubmittedWorkDone(),await t?.collect()}}}class Ht{constructor(e,t,s,r,n,i={}){this.ctx=e,this.kernels=t;const c=s.manifest.config,l=c.n_text_state,d=c.ffn_dim,u=c.n_text_head,p=c.n_text_layer,b=c.n_vocab,y=c.n_audio_ctx,P=c.n_text_ctx,o=h=>s.get(h);this.beams=i.beams??1,this.active=this.beams,this.maxRows=Math.max(i.maxRows??256,this.beams),this.logitRows=i.logitRows??this.beams;const f=this.maxRows;this.crossGraph=new X("decoder.cross");const U=new at(t,this.crossGraph),B=[];for(let h=0;h<p;h++){const m=r.alloc([y,2*l],"f32",`dec.cross_kv.${h}`);B.push(m),U.matmul(`decoder.blocks.${h}.cross.kv`,{out:m,a:n,b:o(`decoder.blocks.${h}.cross.kv.weight`),bias:o(`decoder.blocks.${h}.cross.kv.bias`),M:y,N:2*l,K:l}),this.crossGraph.cut()}const x=r.alloc([f,l],"f32","dec.x"),g=r.alloc([f,l],"f32","dec.norm"),$=r.alloc([f,l],"f32","dec.q"),M=r.alloc([f,l],"f32","dec.attn"),G=r.alloc([f,d],"f32","dec.ffn");this.ids=r.alloc([f],"u32","dec.ids"),this.path=r.alloc([this.beams*P],"u32","dec.path"),this.partial=r.alloc([vt*u*W],"f32","dec.attn_partial"),this.logits=r.alloc([this.logitRows,b],"f32","dec.logits"),this.identity=new Uint32Array(this.beams*P);const q=[];for(let h=0;h<p;h++)q.push(r.alloc([P*this.beams,2*l],"f32",`dec.self_kv.${h}`));this.stepGraph=new X("decoder.step");const k=new at(t,this.stepGraph),E=this.beams*2*l,R=k.embed("decoder.embed",{out:x,ids:this.ids,tok:o("decoder.tok_emb"),pos:o("decoder.pos_emb"),N:f,D:l,posBase:0,beams:this.beams});this.patches.push({node:R,update:({rows:h,pos:m,batch:S})=>{const _=h*S;this.setUniform(R,$t({N:_,D:l,posBase:m,beams:S})),R.wg[1]=_}});for(let h=0;h<p;h++){const m=`decoder.blocks.${h}`;this.norm(k,`${m}.ln1`,g,x,o(`${m}.ln1.weight`),o(`${m}.ln1.bias`),l),this.proj(k,`${m}.attn.q`,{out:$,a:g,b:o(`${m}.attn.qkv.weight`),bias:o(`${m}.attn.qkv.bias`),N:l,K:l});const S=k.matmul(`${m}.attn.kv`,{out:q[h],a:g,b:o(`${m}.attn.qkv.weight`),bias:o(`${m}.attn.qkv.bias`),M:f,N:2*l,K:l,bOff:l*l,biasOff:l,gemv:ft});this.patches.push({node:S,update:({rows:A,pos:I,batch:N})=>{const O=A*N;this.setUniform(S,Q({M:O,N:2*l,K:l,bOff:l*l,biasOff:l,cOff:I*E,ldc:A>1?E:2*l})),k.tuneMatmul(S,O,2*l)}});const _=k.attentionSplit(`${m}.attn`,{out:M,q:$,k:q[h],v:q[h],partial:this.partial,path:this.path,shape:{T:1,S:1,heads:u,batch:this.beams},layout:{ldq:l,ldk:E,ldv:E,ldo:l,offV:l,bsQ:l,bsK:2*l,bsV:2*l,bsO:l,hsQ:v,hsK:v,hsV:v,hsO:v},causal:!0});this.patches.push({node:_.split,update:({rows:A,pos:I,batch:N})=>{const O=I+A,ct=A*N,ut=H(O,ct);this.setUniform(_.split,rt({T:A,S:O,heads:u},{ldq:l*N,ldk:E,ldv:E,offV:l,bsQ:l,bsK:2*l,bsV:2*l,hsQ:v,hsK:v,hsV:v},{causal:!0,qPos:I},ut,ct)),this.setWg(_.split,st({T:A,heads:u,batch:N},ut.nSl))}}),this.patches.push({node:_.combine,update:({rows:A,pos:I,batch:N})=>{const O=A*N;this.setUniform(_.combine,it({qTot:O,heads:u,nSl:H(I+A,O).nSl,T:A,layout:{ldo:l*N,bsO:l}})),this.setWg(_.combine,nt(O,u))}}),this.proj(k,`${m}.attn.out`,{out:x,a:M,b:o(`${m}.attn.out.weight`),bias:o(`${m}.attn.out.bias`),N:l,K:l,accumulate:!0}),this.norm(k,`${m}.ln_cross`,g,x,o(`${m}.ln_cross.weight`),o(`${m}.ln_cross.bias`),l),this.proj(k,`${m}.cross.q`,{out:$,a:g,b:o(`${m}.cross.q.weight`),bias:o(`${m}.cross.q.bias`),N:l,K:l});const z=k.attentionSplit(`${m}.cross`,{out:M,q:$,k:B[h],v:B[h],partial:this.partial,shape:{T:this.beams,S:y,heads:u,batch:1},layout:{ldq:l,ldk:2*l,ldv:2*l,ldo:l,offV:l,hsQ:v,hsK:v,hsV:v,hsO:v}});this.patches.push({node:z.split,update:({rows:A,batch:I})=>{const N=A*I,O=H(y,N);this.setUniform(z.split,rt({T:N,S:y,heads:u},{ldq:l,ldk:2*l,ldv:2*l,offV:l,hsQ:v,hsK:v,hsV:v},{},O,N)),this.setWg(z.split,st({T:N,heads:u,batch:1},O.nSl))}}),this.patches.push({node:z.combine,update:({rows:A,batch:I})=>{const N=A*I;this.setUniform(z.combine,it({qTot:N,heads:u,nSl:H(y,N).nSl,T:N,layout:{ldo:l}})),this.setWg(z.combine,nt(N,u))}}),this.proj(k,`${m}.cross.out`,{out:x,a:M,b:o(`${m}.cross.out.weight`),bias:o(`${m}.cross.out.bias`),N:l,K:l,accumulate:!0}),this.norm(k,`${m}.ln2`,g,x,o(`${m}.ln2.weight`),o(`${m}.ln2.bias`),l),this.proj(k,`${m}.mlp.fc1`,{out:G,a:g,b:o(`${m}.mlp.fc1.weight`),bias:o(`${m}.mlp.fc1.bias`),N:d,K:l,act:"gelu"}),this.proj(k,`${m}.mlp.fc2`,{out:x,a:G,b:o(`${m}.mlp.fc2.weight`),bias:o(`${m}.mlp.fc2.bias`),N:l,K:d,accumulate:!0})}const L=k.layerNorm("decoder.ln",{out:g,x,weight:o("decoder.ln.weight"),bias:o("decoder.ln.bias"),M:this.logitRows,K:l});this.patches.push({node:L,update:({rows:h,batch:m,logits:S})=>{this.setUniform(L,ot({M:S,K:l,aOff:(h*m-S)*l})),L.wg[0]=S}});const w=k.matmul("decoder.logits",{out:this.logits,a:g,b:o("decoder.tok_emb"),M:this.logitRows,N:b,K:l});this.patches.push({node:w,update:({logits:h})=>{this.setUniform(w,Q({M:h,N:b,K:l})),k.tuneMatmul(w,h,b)}}),r.release(g,$,M,G)}crossGraph;stepGraph;logits;beams;active;maxRows;logitRows;ids;path;partial;patches=[];identity;proj(e,t,s){const r=Math.ceil(s.N/et.gn)>=32,n=e.matmul(t,{...s,M:this.maxRows,gemv:s.gemv??(r?et:ft)});this.patches.push({node:n,update:({rows:i,batch:c})=>{const l=i*c;this.setUniform(n,Q({M:l,N:s.N,K:s.K})),e.tuneMatmul(n,l,s.N)}})}norm(e,t,s,r,n,i,c){const l=e.layerNorm(t,{out:s,x:r,weight:n,bias:i,M:this.maxRows,K:c});this.patches.push({node:l,update:({rows:d,batch:u})=>{this.setUniform(l,ot({M:d*u,K:c})),l.wg[0]=d*u}})}setUniform(e,t){this.kernels.uniforms.write(e.uniformOffset,t)}setWg(e,t){e.wg[0]=t[0],e.wg[1]=t[1],e.wg[2]=t[2]}setBeams(e){if(e<1||e>this.beams)throw new Error(`decoder: ${e} beams, allocated ${this.beams}`);this.active=e}crossChunks(e=1){return this.crossGraph.chunks(e)}encodeCross(e,t,s){this.crossGraph.encode(e,t,s)}encodeStep(e,t,s){const r=t.rows>1?1:this.active,n=t.rows*r;if(n>this.maxRows)throw new Error(`decoder: ${n} rows exceeds ${this.maxRows}`);const i=Math.min(n,this.logitRows);this.ctx.queue.writeBuffer(this.ids.buffer,0,t.tokens,0,n);const c=t.pos+t.rows,l=t.path??this.identity.subarray(0,r*c);if(!t.path)for(let d=0;d<r;d++)for(let u=0;u<c;u++)this.identity[d*c+u]=d;this.ctx.queue.writeBuffer(this.path.buffer,0,l,0,r*c);for(const d of this.patches)d.update({rows:t.rows,pos:t.pos,batch:r,logits:i});this.stepGraph.encode(e,void 0,s)}}const yt=4;class Qt{constructor(e,t,s,r){this.ctx=e,this.decoder=t,this.ctxLen=s,this.active=t.beams,this.vocab=r,this.paths=Array.from({length:t.beams},()=>new Uint32Array(s)),this.pathScratch=Array.from({length:t.beams},()=>new Uint32Array(s)),this.flat=new Uint32Array(t.beams*s),this.tokenUpload=new Uint32Array(s)}profiler;sampler;stepSelect;active;paths;pathScratch;flat;tokenUpload;vocab;get beams(){return this.active}setBeams(e){this.decoder.setBeams(e),this.active=e}async prepare(){for(const e of this.decoder.crossChunks(yt)){const t=this.ctx.device.createCommandEncoder();this.decoder.encodeCross(t,e,this.profiler),this.profiler?.resolve(t),this.ctx.queue.submit([t.finish()]),await this.ctx.queue.onSubmittedWorkDone(),await this.profiler?.collect()}}async prefill(e){for(const i of this.paths)i.fill(0,0,e.length);e.length>this.tokenUpload.length&&(this.tokenUpload=new Uint32Array(e.length)),this.tokenUpload.set(e);const t=this.ctx.device.createCommandEncoder();this.decoder.encodeStep(t,{tokens:this.tokenUpload.subarray(0,e.length),rows:e.length,pos:0}),this.ctx.queue.submit([t.finish()]);const s=await this.read(),r=e.length>1?e.length:this.active,n=Math.min(r,s.length/this.vocab);return s.slice((n-1)*this.vocab,n*this.vocab)}async step(e,t){const s=this.encodeStep(e,t);this.profiler?.resolve(s),this.ctx.queue.submit([s.finish()]);const r=await this.read();return await this.profiler?.collect(),r}useSampler(e){this.sampler=e,this.stepSelect=(t,s,r,n)=>this.runSelect(t,s,r,n)}async runSelect(e,t,s,r){const n=this.encodeStep(e,t);this.sampler.encode(n,s,r,this.profiler),this.profiler?.resolve(n),this.ctx.queue.submit([n.finish()]);const i=await this.sampler.read(s.length,r);return await this.profiler?.collect(),i}encodeStep(e,t){const s=t+1;for(let n=0;n<this.active;n++)this.paths[n][t]=n,this.flat.set(this.paths[n].subarray(0,s),n*s);this.tokenUpload.set(e);const r=this.ctx.device.createCommandEncoder();return this.decoder.encodeStep(r,{tokens:this.tokenUpload.subarray(0,e.length),rows:1,pos:t,path:this.flat.subarray(0,this.active*s)},this.profiler),r}reorder(e){for(let s=0;s<e.length;s++)this.pathScratch[s].set(this.paths[e[s]]);const t=this.paths;this.paths=this.pathScratch,this.pathScratch=t}async read(){const e=this.decoder.logits,t=await Ft(this.ctx.device,e.buffer,e.size*4);return new Float32Array(t,0,e.size)}}const mt=.02,Yt=/'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu,J=new TextEncoder,jt=new TextDecoder;function Xt(){const a=new Set;for(let s=33;s<=126;s++)a.add(s);for(let s=161;s<=172;s++)a.add(s);for(let s=174;s<=255;s++)a.add(s);const e=new Array(256);let t=0;for(let s=0;s<256;s++)e[s]=a.has(s)?String.fromCharCode(s):String.fromCharCode(256+t++);return e}class lt{nVocab;sot;eot;sotLm;sotPrev;noSpeech;noTimestamps;transcribe;translate;timestampBegin;vocab;added;languages;ids=new Map;ranks=new Map;byteEncoder=Xt();byteDecoder=new Int16Array(512).fill(-1);bpeCache=new Map;bytes=new Uint8Array(1024);constructor(e){this.vocab=e.vocab,this.nVocab=e.vocab.length,this.added=new Set(e.added_token_ids),this.languages=e.languages;for(let s=0;s<256;s++)this.byteDecoder[this.byteEncoder[s].charCodeAt(0)]=s;for(let s=0;s<e.vocab.length;s++){const r=e.vocab[s];r===""||this.added.has(s)||this.ids.set(r,s)}for(let s=0;s<e.merges.length;s++)this.ranks.set(e.merges[s],s);const t=s=>{const r=e.special_tokens[s];if(r===void 0)throw new Error(`tokenizer: missing special token ${s}`);return r};this.sot=t("<|startoftranscript|>"),this.eot=t("<|endoftext|>"),this.sotLm=t("<|startoflm|>"),this.sotPrev=t("<|startofprev|>"),this.noSpeech=t("<|nospeech|>"),this.noTimestamps=t("<|notimestamps|>"),this.transcribe=t("<|transcribe|>"),this.translate=t("<|translate|>"),this.timestampBegin=t("<|0.00|>")}static async load(e){return new lt(Jt(await e.tokenizer()))}token(e){if(e<0||e>=this.vocab.length)throw new Error(`tokenizer: id ${e} out of range`);return this.vocab[e]}isSpecial(e){return this.added.has(e)}isTimestamp(e){return e>=this.timestampBegin&&e<this.nVocab}timestampToSeconds(e){return(e-this.timestampBegin)*mt}timestampToken(e){return this.timestampBegin+Math.round(e/mt)}langToken(e){const t=this.languages[e.toLowerCase()];if(t===void 0)throw new Error(`tokenizer: unknown language ${e}`);return t}hasLanguage(e){return this.languages[e.toLowerCase()]!==void 0}idOfText(e){const t=J.encode(e);let s="";for(let r=0;r<t.length;r++)s+=this.byteEncoder[t[r]];return this.ids.get(s)??-1}encode(e){const t=[];for(const s of e.matchAll(Yt)){const r=J.encode(s[0]);let n="";for(let l=0;l<r.length;l++)n+=this.byteEncoder[r[l]];const i=this.bpeCache.get(n);if(i){for(const l of i)t.push(l);continue}const c=this.bpe(n);this.bpeCache.set(n,c);for(const l of c)t.push(l)}return t}decode(e,t={}){const s=t.skipSpecial??!1;let r=0;for(const n of e){if(n<0||n>=this.vocab.length)throw new Error(`tokenizer: id ${n} out of range`);if(this.added.has(n)){if(s)continue;const c=J.encode(this.vocab[n]);r=this.push(c,r);continue}const i=this.vocab[n];this.reserve(r+i.length);for(let c=0;c<i.length;c++){const l=this.byteDecoder[i.charCodeAt(c)];if(l<0)throw new Error(`tokenizer: id ${n} has non-byte char ${i[c]}`);this.bytes[r++]=l}}return jt.decode(this.bytes.subarray(0,r))}push(e,t){return this.reserve(t+e.length),this.bytes.set(e,t),t+e.length}reserve(e){if(e<=this.bytes.length)return;let t=this.bytes.length*2;for(;t<e;)t*=2;const s=new Uint8Array(t);s.set(this.bytes),this.bytes=s}bpe(e){let t=[...e];for(;t.length>1;){let s=1/0,r=-1;for(let i=0;i<t.length-1;i++){const c=this.ranks.get(`${t[i]} ${t[i+1]}`);c!==void 0&&c<s&&(s=c,r=i)}if(r<0)break;const n=[];for(let i=0;i<t.length;i++)i===r?(n.push(t[i]+t[i+1]),i++):n.push(t[i]);t=n}return t.map(s=>{const r=this.ids.get(s);if(r===void 0)throw new Error(`tokenizer: no id for piece ${JSON.stringify(s)}`);return r})}}function Jt(a){const e=a;if(!e||!Array.isArray(e.vocab)||!Array.isArray(e.merges)||!Array.isArray(e.added_token_ids)||!e.special_tokens||!e.languages)throw new Error("tokenizer: malformed tokenizer.json");return e}const Zt=['"',"#","(",")","*","+","/",":",";","<","=",">","@","[","\\","]","^","_","`","{","|","}","~","「","」","『","』","<<",">>","<<<",">>>","--","---","-(","-[","('",'("',"((","))","(((",")))","[[","]]","{{","}}","♪♪","♪♪♪","♩","♪","♫","♬","♭","♮","♯"],te={suppressBlank:!0,suppressNonSpeech:!1,noTimestamps:!1,maxInitialTs:1,suppressTokens:[]};class bt{constructor(e,t=te){this.tok=e,this.params=t,this.n=e.nVocab,this.beg=e.timestampBegin,this.timestampBegin=this.beg,this.eot=e.eot,this.noSpeech=e.noSpeech,this.logprobs=new Float32Array(this.n),this.always.push(e.noTimestamps,e.sot,e.noSpeech,e.sotLm),this.always.push(e.translate,e.transcribe,e.sotPrev);for(let r=1;r<=100;r++)this.always.push(e.sot+r);for(const r of t.suppressTokens)this.always.push(r);this.blank.push(e.eot);const s=e.idOfText(" ");s>=0&&this.blank.push(s);for(const r of Zt)for(const n of[r,` ${r}`]){const i=e.idOfText(n);i>=0&&this.nonSpeech.push(i)}for(const r of[" -"," '"]){const n=e.idOfText(r);n>=0&&this.nonSpeech.push(n)}}always=[];nonSpeech=[];blank=[];timestampBegin;eot;noSpeech;beg;n;logprobs;maskSpec(){const e=new Uint32Array(Math.ceil(this.n/32));for(const t of this.always)t>=0&&t<this.n&&(e[t>>>5]|=1<<(t&31));if(this.params.suppressNonSpeech)for(const t of this.nonSpeech)e[t>>>5]|=1<<(t&31);return{bits:e,blank:this.params.suppressBlank?this.blank.slice():[],noTimestamps:this.params.noTimestamps,maxInitialTid:this.params.maxInitialTs>0?this.beg+Math.round(this.params.maxInitialTs/.02)+1:this.n,vocab:this.n,beg:this.beg,eot:this.eot}}maskState(e){const t=e.tokens;return{initial:t.length===0,lastWasTs:t.length>0&&t[t.length-1]>=this.beg,penultWasTs:t.length<2||t[t.length-2]>=this.beg,hasTs:e.hasTs,seekDelta:e.seekDelta}}apply(e,t,s){const r=this.n,n=this.beg,i=t.tokens.length===0;if(s>0)for(let o=0;o<r;o++)e[o]/=s;if(this.params.suppressBlank&&i)for(const o of this.blank)e[o]=-1/0;if(this.params.noTimestamps)for(let o=n;o<r;o++)e[o]=-1/0;for(const o of this.always)e[o]=-1/0;if(this.params.suppressNonSpeech)for(const o of this.nonSpeech)e[o]=-1/0;const c=t.tokens[t.tokens.length-1],l=t.tokens.length>0&&c>=n,d=t.tokens.length<2||t.tokens[t.tokens.length-2]>=n;if(l)if(d)for(let o=n;o<r;o++)e[o]=-1/0;else for(let o=0;o<this.eot;o++)e[o]=-1/0;if(i&&this.params.maxInitialTs>0){const o=Math.round(this.params.maxInitialTs/.02);for(let f=n+o+1;f<r;f++)e[f]=-1/0}if(t.hasTs){const o=Math.floor(t.seekDelta/2);for(let f=n;f<n+o;f++)e[f]=-1/0}this.logSoftmax(e);const u=this.logprobs;let p=-1/0;for(let o=n;o<r;o++)u[o]>p&&(p=u[o]);let b=0;if(p>-1/0)for(let o=n;o<r;o++)u[o]>-1/0&&(b+=Math.exp(u[o]-p));const y=p>-1/0?Math.log(b)+p:-1/0;let P=-1/0;for(let o=0;o<n;o++)u[o]>P&&(P=u[o]);if(y>P)for(let o=0;o<n;o++)e[o]=-1/0,u[o]=-1/0;return u}logSoftmax(e){const t=this.n;let s=-1/0;for(let i=0;i<t;i++)e[i]>s&&(s=e[i]);let r=0;for(let i=0;i<t;i++)e[i]>-1/0&&(r+=Math.exp(e[i]-s));const n=Math.log(r)+s;for(let i=0;i<t;i++)this.logprobs[i]=e[i]>-1/0?e[i]-n:-1/0}}const kt=256,D={Active:1,Initial:2,LastWasTs:4,PenultWasTs:8,HasTs:16},j=4;function Z(a){return 2*a}function ee(a){return kt*(2*4+a*8)}function se(a){if(!Number.isInteger(a)||a<1)throw new Error(`sample: k=${a} must be a positive integer`);const e=ee(a);if(e>16384)throw new Error(`sample: k=${a} needs ${e}B workgroup storage`);const t=kt;return`
struct Params {
  V: u32, beg: u32, eot: u32, stride: u32,
  blank0: u32, blank1: u32, noTimestamps: u32, maxInitialTid: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> Out: array<u32>;
@group(0) @binding(2) var<storage, read> L: array<f32>;
@group(0) @binding(3) var<storage, read> Mask: array<u32>;
@group(0) @binding(4) var<storage, read> State: array<u32>;

var<workgroup> redA: array<f32, ${t}>;
var<workgroup> redB: array<f32, ${t}>;
var<workgroup> sv: array<f32, ${t*a}>;
var<workgroup> si: array<u32, ${t*a}>;

// Stands in for -inf. A WGSL const-expression may not evaluate to an infinity,
// which Tint enforces and naga does not, so spelling it bitcast<f32>(0xff800000u)
// is rejected by Dawn and silently accepted by wgpu. Nothing here does
// arithmetic on a masked value — every use is a comparison against another
// candidate, or is guarded by a test against NEG itself — so the least finite
// f32 serves. The readback still reports a true -inf; see the store below.
fn ninf() -> f32 { return bitcast<f32>(0xff7fffffu); }

/** The logit after masks (1)-(9), or -inf. The forced-timestamp rule is later. */
fn masked(base: u32, i: u32, flags: u32, tsFloor: u32) -> f32 {
  let NEG = ninf();
  if ((Mask[i >> 5u] & (1u << (i & 31u))) != 0u) { return NEG; }
  let initial = (flags & ${D.Initial}u) != 0u;
  if (initial && (i == P.blank0 || i == P.blank1)) { return NEG; }
  if (P.noTimestamps != 0u && i >= P.beg) { return NEG; }
  // Timestamps come in pairs: after one the model must emit text or EOT, after
  // two it must emit text.
  if ((flags & ${D.LastWasTs}u) != 0u) {
    if ((flags & ${D.PenultWasTs}u) != 0u) {
      if (i >= P.beg) { return NEG; }
    } else if (i < P.eot) {
      return NEG;
    }
  }
  if (initial && i >= P.maxInitialTid) { return NEG; }
  if ((flags & ${D.HasTs}u) != 0u && i >= P.beg && i < tsFloor) { return NEG; }
  return L[base + i];
}

/** Total order over candidates: higher value first, lower id breaks ties. */
fn better(av: f32, ai: u32, bv: f32, bi: u32) -> bool {
  return av > bv || (av == bv && ai < bi);
}

@compute @workgroup_size(${t})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) tid: u32) {
  let b = wg.x;
  let flags = State[b * ${j}u];
  let tsFloor = State[b * ${j}u + 1u];
  let out = b * ${2*a}u;
  // Uniform across the workgroup, so skipping a finished beam skips every
  // barrier below with it.
  if ((flags & ${D.Active}u) == 0u) {
    if (tid == 0u) {
      for (var t = 0u; t < ${a}u; t++) { Out[out + t] = 0xffffffffu; }
    }
    return;
  }
  let base = b * P.stride;
  let NEG = ninf();

  var textMax = NEG;
  var tsMax = NEG;
  for (var i = tid; i < P.V; i += ${t}u) {
    let v = masked(base, i, flags, tsFloor);
    if (i < P.beg) { textMax = max(textMax, v); } else { tsMax = max(tsMax, v); }
  }
  redA[tid] = textMax;
  redB[tid] = tsMax;
  workgroupBarrier();
  for (var s = ${t/2}u; s > 0u; s >>= 1u) {
    if (tid < s) {
      redA[tid] = max(redA[tid], redA[tid + s]);
      redB[tid] = max(redB[tid], redB[tid + s]);
    }
    workgroupBarrier();
  }
  textMax = redA[0];
  tsMax = redB[0];
  let gmax = max(textMax, tsMax);
  workgroupBarrier();

  var se = 0.0;
  var ts = 0.0;
  for (var i = tid; i < P.V; i += ${t}u) {
    let v = masked(base, i, flags, tsFloor);
    if (v > NEG) {
      se += exp(v - gmax);
      if (i >= P.beg) { ts += exp(v - tsMax); }
    }
  }
  redA[tid] = se;
  redB[tid] = ts;
  workgroupBarrier();
  for (var s = ${t/2}u; s > 0u; s >>= 1u) {
    if (tid < s) {
      redA[tid] += redA[tid + s];
      redB[tid] += redB[tid + s];
    }
    workgroupBarrier();
  }
  let lse = log(redA[0]) + gmax;
  // If the timestamps collectively outweigh the best single text token, force a
  // timestamp. Both sides carry the same -lse, so it cancels.
  let force = select(NEG, log(redB[0]) + tsMax, tsMax > NEG) > textMax;

  var lv: array<f32, ${a}>;
  var li: array<u32, ${a}>;
  for (var t = 0u; t < ${a}u; t++) { lv[t] = NEG; li[t] = 0xffffffffu; }
  for (var i = tid; i < P.V; i += ${t}u) {
    var v = masked(base, i, flags, tsFloor);
    if (force && i < P.beg) { v = NEG; }
    if (better(v, i, lv[${a-1}u], li[${a-1}u])) {
      var p = ${a-1}u;
      while (p > 0u && better(v, i, lv[p - 1u], li[p - 1u])) {
        lv[p] = lv[p - 1u];
        li[p] = li[p - 1u];
        p -= 1u;
      }
      lv[p] = v;
      li[p] = i;
    }
  }
  for (var t = 0u; t < ${a}u; t++) {
    sv[tid * ${a}u + t] = lv[t];
    si[tid * ${a}u + t] = li[t];
  }
  workgroupBarrier();
  // Merge the sorted per-thread lists pairwise. Thread tid only writes its own
  // slice and only reads slice tid+s, which no writer in this step owns.
  for (var s = ${t/2}u; s > 0u; s >>= 1u) {
    if (tid < s) {
      let A = tid * ${a}u;
      let B = (tid + s) * ${a}u;
      var x = 0u;
      var y = 0u;
      for (var t = 0u; t < ${a}u; t++) {
        if (better(sv[A + x], si[A + x], sv[B + y], si[B + y])) {
          lv[t] = sv[A + x];
          li[t] = si[A + x];
          x += 1u;
        } else {
          lv[t] = sv[B + y];
          li[t] = si[B + y];
          y += 1u;
        }
      }
      for (var t = 0u; t < ${a}u; t++) {
        sv[A + t] = lv[t];
        si[A + t] = li[t];
      }
    }
    workgroupBarrier();
  }

  if (tid == 0u) {
    for (var t = 0u; t < ${a}u; t++) {
      Out[out + t] = si[t];
      let v = sv[t];
      // 0xff800000 is -inf as a u32 literal, which is legal where the f32
      // const-expression is not, and is what the caller expects for a masked
      // token: the CPU filter yields -Infinity there.
      Out[out + ${a}u + t] = select(0xff800000u, bitcast<u32>(v - lse), v > NEG);
    }
  }
}`}class re{constructor(e,t,s,r,n,i){this.ctx=e,this.kernels=t,this.logits=s,this.beams=r,this.maxK=n;const c=e.device,l=i.logprobs.length;this.beg=i.timestampBegin,this.out=c.createBuffer({size:r*Z(n)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,label:"sample-out"}),this.staging=c.createBuffer({size:this.out.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,label:"sample-readback"}),this.mask=c.createBuffer({size:Math.ceil(l/32)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,label:"sample-mask"}),this.state=new Uint32Array(r*j),this.stateBuf=c.createBuffer({size:this.state.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,label:"sample-state"}),this.result={tokens:new Uint32Array(r*n),plogs:new Float32Array(r*n)},this.uniformOffset=t.uniforms.alloc(new Uint32Array(8)),this.configure(i)}out;staging;mask;stateBuf;state;uniformOffset;beg;pipelines=new Map;result;outBytes=0;configure(e){const t=e.maskSpec();if(t.beg!==this.beg)throw new Error("sampler: filter vocabulary changed");this.ctx.queue.writeBuffer(this.mask,0,t.bits),this.kernels.uniforms.write(this.uniformOffset,new Uint32Array([t.vocab,t.beg,t.eot,this.logits.shape[1],t.blank[0]??4294967295,t.blank[1]??4294967295,t.noTimestamps?1:0,t.maxInitialTid]))}encode(e,t,s,r){if(s<1||s>this.maxK)throw new Error(`sampler: k=${s}, built for ${this.maxK}`);if(t.length>this.beams)throw new Error(`sampler: ${t.length} beams, built for ${this.beams}`);this.state.fill(0),t.forEach((d,u)=>{let p=0;d.active&&(p|=D.Active),d.initial&&(p|=D.Initial),d.lastWasTs&&(p|=D.LastWasTs),d.penultWasTs&&(p|=D.PenultWasTs),d.hasTs&&(p|=D.HasTs),this.state[u*j]=p,this.state[u*j+1]=this.beg+Math.floor(d.seekDelta/2)}),this.ctx.queue.writeBuffer(this.stateBuf,0,this.state);const{pipeline:n,bg:i}=this.variant(s),c=r?.claim("decoder.sample"),l=e.beginComputePass(c?{label:"decoder.sample",timestampWrites:c}:{label:"decoder.sample"});l.setPipeline(n),l.setBindGroup(0,i,[this.uniformOffset]),l.dispatchWorkgroups(t.length,1,1),l.end(),this.outBytes=t.length*Z(s)*4,e.copyBufferToBuffer(this.out,0,this.staging,0,this.outBytes)}async read(e,t){await this.staging.mapAsync(GPUMapMode.READ,0,this.outBytes);const s=new Uint32Array(this.staging.getMappedRange(0,this.outBytes)),r=Z(t);for(let n=0;n<e;n++)for(let i=0;i<t;i++)this.result.tokens[n*t+i]=s[n*r+i],this.result.plogs[n*t+i]=ie(s[n*r+t+i]);return this.staging.unmap(),this.result}variant(e){const t=this.pipelines.get(e);if(t)return t;const s=this.kernels.kernel({name:`sample-k${e}`,code:se(e),writes:1,reads:3}),r={pipeline:s.pipeline,bg:this.kernels.bindGroup(s,[this.out,this.logits,this.mask,this.stateBuf])};return this.pipelines.set(e,r),r}destroy(){this.out.destroy(),this.staging.destroy(),this.mask.destroy(),this.stateBuf.destroy()}}const gt=new DataView(new ArrayBuffer(4));function ie(a){return gt.setUint32(0,a,!0),gt.getFloat32(0,!0)}async function ne(a,e,t,s){const r=Math.max(1,s.beamSize),n=e.logprobs.length,i=e.timestampBegin,c=s.temperature>1e-6,l=s.rng??Math.random,d=s.temperature===0&&a.stepSelect!==void 0;let u=null;a.setBeams(r);let p=0,b=performance.now();const y=await a.prefill(t);p+=performance.now()-b;const P=ae(y,e.noSpeech);let o=[];const f=[];for(let g=0;g<r;g++)o.push({tokens:[],plogs:[],sumAll:0,resultLen:0,seekDelta:3e3,hasTs:!1,completed:!1,failed:!1,logits:y.slice(0,n)});let U=0;const B=Math.min(s.stepLimit,s.maxTokens>0?s.maxTokens+1:s.stepLimit);for(let g=0;g<B;g++){U=g+1;const $=o.length;if($===0)break;const M=[];for(let w=0;w<$;w++){const h=o[w];if(u){for(let _=0;_<r;_++){const z=u.tokens[w*r+_],A=u.plogs[w*r+_];M.push({from:w,token:z,plog:A,sumAll:h.sumAll+A})}continue}const m=e.apply(h.logits,h,s.temperature),S=c?[ue(m,l)]:$===1?[xt(m)]:he(m,r);for(const _ of S)M.push({from:w,token:_,plog:m[_],sumAll:h.sumAll+m[_]})}if(M.length===0)break;const G=new Array($).fill(0),q=new Array($).fill(null);if(c){for(let w=0;w<$;w++)G[w]=w;for(const w of M)q[w.from]=w}else{M.sort((h,m)=>m.sumAll-h.sumAll||h.from-m.from);let w=0;for(let h=0;h<$;h++){w>=M.length&&(w=0);const m=M[w++];for(;w<M.length&&ce(o,M[w],m);)w++;q[h]=m,G[h]=m.from}}const k=o.map((w,h)=>{const m=q[h];if(!m)return w;const S=o[m.from];return{tokens:[...S.tokens,m.token],plogs:[...S.plogs,m.plog],sumAll:m.sumAll,resultLen:S.resultLen,seekDelta:S.seekDelta,hasTs:S.hasTs,completed:!1,failed:!1,logits:w.logits}});a.reorder(G);for(let w=0;w<$;w++){const h=k[w];if(!q[w])continue;const m=h.tokens[h.tokens.length-1];if(m>i){const _=2*(m-i);if(h.hasTs&&h.seekDelta>_&&h.resultLen<g){h.failed=!0;continue}h.seekDelta=_,h.resultLen=g+1,h.hasTs=!0}const S=h.hasTs&&s.seek+h.seekDelta+s.deltaMin>=s.seekEnd;if(m===e.eot||s.maxTokens>0&&g>=s.maxTokens||S){if(h.resultLen===0&&!s.noTimestamps)if(S)h.resultLen=g+1;else{h.failed=!0;continue}(s.singleSegment||s.noTimestamps)&&(h.resultLen=g+1,h.seekDelta=3e3),h.completed=!0;continue}g===B-1&&(h.resultLen===0||h.seekDelta<1500)&&(h.failed=!0)}const E=[],R=[];for(let w=0;w<k.length;w++){const h=k[w];h.completed||h.failed?f.push(h):(R.push(w),E.push(h))}if(E.length===0){o=[];break}E.length!==k.length&&(a.reorder(R),a.setBeams(E.length)),o=E;const L=o.map(w=>w.tokens[w.tokens.length-1]??e.eot);if(b=performance.now(),d)u=await a.stepSelect(L,t.length+g,o.map(w=>({...e.maskState(w),active:!0})),r);else{const w=await a.step(L,t.length+g);for(let h=0;h<o.length;h++)o[h].logits=w.slice(h*n,(h+1)*n)}p+=performance.now()-b}const x=oe(o.concat(f),s,P);return x.steps=U,x.gpuMs=p,x}function oe(a,e,t){const s=a.map(n=>{const i=le(n,e);return i.noSpeechProb=t,i.tokens.length>32&&i.entropy<e.entropyThold&&(i.failed=!0),i});let r=s[0];for(const n of s)n.failed||(r.failed||n.score>r.score)&&(r=n);return r}function ae(a,e){let t=-1/0;for(let r=0;r<a.length;r++)a[r]>t&&(t=a[r]);let s=0;for(let r=0;r<a.length;r++)s+=Math.exp(a[r]-t);return Math.exp(a[e]-t)/s}function le(a,e){const t=a.resultLen,s=a.tokens.slice(0,t),r=a.plogs.slice(0,t);if(t===0)return{tokens:s,logprobs:r,avgLogprob:-1/0,score:-1/0,entropy:0,seekDelta:a.seekDelta,failed:!0,temperature:e.temperature,noSpeechProb:0,steps:0,gpuMs:0};let n=0;for(const p of r)n+=p;const i=e.lengthPenalty>0?((5+t)/6)**e.lengthPenalty:t,c=new Map,l=Math.max(0,t-32);for(let p=l;p<t;p++)c.set(s[p],(c.get(s[p])??0)+1);const d=t-l;let u=0;for(const p of c.values())u-=p/d*Math.log(p/d);return{tokens:s,logprobs:r,avgLogprob:n/t,score:n/i,entropy:u,seekDelta:a.seekDelta,failed:a.failed,temperature:e.temperature,noSpeechProb:0,steps:0,gpuMs:0}}function ce(a,e,t){if(e.token!==t.token)return!1;const s=a[e.from].tokens,r=a[t.from].tokens;if(s.length!==r.length)return!1;for(let n=s.length-1;n>=0;n--)if(s[n]!==r[n])return!1;return!0}function ue(a,e){let t=0;for(let r=0;r<a.length;r++)a[r]>-1/0&&(t+=Math.exp(a[r]));let s=e()*t;for(let r=0;r<a.length;r++)if(a[r]!==-1/0&&(s-=Math.exp(a[r]),s<=0))return r;return xt(a)}function xt(a){let e=0;for(let t=1;t<a.length;t++)a[t]>a[e]&&(e=t);return e}function he(a,e){const t=[],s=[];for(let r=0;r<a.length;r++){const n=a[r];if(t.length<e){let i=t.length;for(t.push(r),s.push(n);i>0&&s[i-1]<n;)s[i]=s[i-1],t[i]=t[i-1],i--;s[i]=n,t[i]=r}else if(n>s[e-1]){let i=e-1;for(;i>0&&s[i-1]<n;)s[i]=s[i-1],t[i]=t[i-1],i--;s[i]=n,t[i]=r}}return t}const fe={language:"en",translate:!1,noTimestamps:!1,singleSegment:!1,beamSize:5,bestOf:5,temperature:0,temperatureInc:.2,lengthPenalty:-1,logprobThold:-1,entropyThold:2.4,noSpeechThold:.6,maxInitialTs:1,suppressBlank:!0,suppressNonSpeech:!1,suppressTokens:[],maxTokens:0,maxTextCtx:16384,noContext:!0,initialPrompt:"",carryInitialPrompt:!1,offsetMs:0,durationMs:0},wt=100;class Pt{constructor(e,t,s,r,n,i,c,l){this.ctx=e,this.weights=t,this.tokenizer=s,this.pool=r,this.mel=n,this.encoder=i,this.decoder=c,this.session=l}mel;encoder;decoder;session;pool;sampler;stats={melMs:0,encoderMs:0,decodeMs:0,decodeGpuMs:0,windows:0,steps:0,attempts:0,emitMs:0,totalMs:0,audioSeconds:0};profiler;onAttempt;history=[];carried=[];static async load(e,t,s={}){const r=new qt(e.device),n=new Ot(e),i=await Gt(e,t,s.onProgress),c=await lt.load(t),l=i.manifest.config,d=i.get("mel_filters"),u=Math.round((s.maxSeconds??900)*Y.sampleRate),p=new Dt(e,n,d,r,u),b=new Wt(e,n,i,r,p.output),y=s.maxBeams??5,P=new Ht(e,n,i,r,b.output,{beams:y,maxRows:Math.floor(l.n_text_ctx/2)+8,logitRows:y}),o=new Qt(e,P,l.n_text_ctx,l.n_vocab),f=new Pt(e,i,c,r,p,b,P,o);return f.sampler=new re(e,n,P.logits,y,y,new bt(c)),o.useSampler(f.sampler),f}resetContext(){this.history=[],this.carried=[]}async*transcribe(e,t={}){const s={...fe,...t},r=this.tokenizer,n=this.weights.manifest.config,i=r.timestampBegin,c=this.stats;c.melMs=c.encoderMs=c.decodeMs=c.emitMs=c.decodeGpuMs=0,c.windows=c.steps=c.attempts=0,c.audioSeconds=e.length/Y.sampleRate;const l=performance.now();let d=performance.now();this.mel.upload(e);const u=this.ctx.device.createCommandEncoder();this.mel.encode(u),this.ctx.queue.submit([u.finish()]),await this.ctx.queue.onSubmittedWorkDone(),c.melMs=performance.now()-d;const p=Math.trunc(s.offsetMs/10),b=s.durationMs===0?this.mel.frames:p+Math.trunc(s.durationMs/10);if(b<p+10)return;s.noContext&&this.resetContext();const y=Math.min(s.maxTextCtx,Math.floor(n.n_text_ctx/2));if(s.initialPrompt){const x=r.encode(s.initialPrompt);s.carryInitialPrompt?this.carried.length===0&&(this.carried=x.slice(Math.max(0,x.length-Math.max(1,y-1)))):this.history=x.concat(this.history)}const P=[r.sot];n.n_vocab>=51865&&(P.push(r.langToken(s.language||"en")),P.push(s.translate?r.translate:r.transcribe)),s.noTimestamps&&P.push(r.noTimestamps);const o=new bt(r,{suppressBlank:s.suppressBlank,suppressNonSpeech:s.suppressNonSpeech,noTimestamps:s.noTimestamps,maxInitialTs:s.maxInitialTs,suppressTokens:s.suppressTokens});this.sampler?.configure(o);const f=de(s.temperature,s.temperatureInc),U=Math.floor(n.n_text_ctx/2)-4;let B=p;for(;B+wt<b;){B>p&&B+500>=b&&(this.history=[],this.carried=[]),d=performance.now(),this.encoder.setWindow(B),this.session.profiler=this.profiler,await this.encoder.run(yt,this.profiler),c.encoderMs+=performance.now()-d,c.windows++,await this.session.prepare(),d=performance.now();let x=[],g;for(let k=0;k<f.length;k++){const E=f[k];x=this.buildPrompt(E,P,y,s),g=await ne(this.session,o,x,{temperature:E,beamSize:E>0?s.bestOf:s.beamSize,lengthPenalty:s.lengthPenalty,maxTokens:s.maxTokens,singleSegment:s.singleSegment,noTimestamps:s.noTimestamps,seek:B,seekEnd:b,deltaMin:wt,stepLimit:U,entropyThold:s.entropyThold,rng:s.rng}),c.steps+=g.steps,c.decodeGpuMs+=g.gpuMs,c.attempts++;const L=!(k===f.length-1)&&(g.failed||g.avgLogprob<s.logprobThold&&g.noSpeechProb<s.noSpeechThold);if(this.onAttempt?.({seek:B,temperature:E,failed:g.failed,avgLogprob:g.avgLogprob,entropy:g.entropy,noSpeechProb:g.noSpeechProb,seekDelta:g.seekDelta,tokens:g.tokens.length,steps:g.steps,retry:L}),!L)break}c.decodeMs+=performance.now()-d;const $=g.noSpeechProb>s.noSpeechThold&&g.avgLogprob<s.logprobThold,M=g.tokens;if(!$){d=performance.now();for(const k of this.segments(M,B,g,s))yield k;c.emitMs+=performance.now()-d}this.history=[],!s.carryInitialPrompt&&x.length>0&&x[0]===r.sotPrev&&(this.history=x.slice(1,x.length-P.length)),$||this.history.push(...M);let G=g.seekDelta;const q=M.length;q>1&&M[q-2]<i&&M[q-1]>i&&(G=Math.min(b-B,Y.nFrames)),B+=Math.max(1,G),c.totalMs=performance.now()-l}}buildPrompt(e,t,s,r){const n=this.tokenizer,i=[];if(r.maxTextCtx>0&&e<.5&&s>0){const c=r.carryInitialPrompt?this.carried.length:0,l=Math.min(s-c-1,this.history.length);(c>0||this.history.length>0)&&(i.push(n.sotPrev),c>0&&i.push(...this.carried.slice(-c)),l>0&&i.push(...this.history.slice(-l)))}return i.push(...t),i}*segments(e,t,s,r){const n=this.tokenizer,i=n.timestampBegin;if(e.length===0)return;let c=0,l=e[0]>i?t+2*(e[0]-i):t,d=0;for(let u=0;u<e.length;u++)if(e[u]<n.eot&&d++,e[u]>i&&!r.singleSegment){const p=t+2*(e[u]-i);if(d>0){const b=e.slice(c,u+1);yield{t0:l,t1:p,text:n.decode(b,{skipSpecial:!0}),tokens:b,noSpeechProb:s.noSpeechProb,temperature:s.temperature}}for(d=0;u<e.length&&e[u]>i;)u++;u--,l=p,c=u+1}if(d>0){const u=e.slice(c);yield{t0:l,t1:t+s.seekDelta,text:n.decode(u,{skipSpecial:!0}),tokens:u,noSpeechProb:s.noSpeechProb,temperature:s.temperature}}}destroy(){this.sampler?.destroy(),this.weights.destroy(),this.pool.destroy()}}function de(a,e){if(!(e>0))return[a];const t=[],s=Math.fround(e);for(let r=Math.fround(a);r<Math.fround(1+1e-6)&&(t.push(r),!(t.length>16));r=Math.fround(r+s));return t}export{me as F,Pt as W,Y as a};
