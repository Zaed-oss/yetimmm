// Minimal Cloudflare Durable Object + Workers runtime mock for testing worker.js / news.js offline.
export class Storage {
  constructor(){ this.m=new Map(); this.alarm=null; }
  async get(k){ if(Array.isArray(k)){const o=new Map();for(const x of k) if(this.m.has(x)) o.set(x,this.m.get(x));return o;} const v=this.m.get(k); return v===undefined?undefined:structuredClone(v); }
  async put(k,v){ if(typeof k==="object"&&v===undefined){ const ks=Object.keys(k); if(ks.length>128) throw new Error("put: max 128 keys"); for(const x of ks) this.m.set(x,structuredClone(k[x])); return; } this.m.set(k,structuredClone(v)); }
  async delete(k){ if(Array.isArray(k)){ if(k.length>128) throw new Error("delete: max 128 keys"); k.forEach(x=>this.m.delete(x)); return k.length; } return this.m.delete(k); }
  async list(o={}){ const r=new Map(); const ks=[...this.m.keys()].filter(k=>!o.prefix||k.startsWith(o.prefix)).sort(); for(const k of ks){ if(o.limit&&r.size>=o.limit)break; r.set(k,structuredClone(this.m.get(k))); } return r; }
  async setAlarm(t){ this.alarm=t; }
}
export function ns(Cls, env){
  const inst=new Map();
  return { idFromName:n=>n, get:(id)=>{ if(!inst.has(id)){ const st=new Storage(); const o=new Cls({storage:st},env); o.__st=st; inst.set(id,o);} const o=inst.get(id);
    return { fetch:async(u,init={})=>{ const req=new Request(u,{method:init.method||"GET",body:init.body}); return o.fetch(req); }, __o:o }; }, inst };
}
