import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {FlowEvidence,fingerprintObserved} from '../lib/flow-evidence.js'
import {renderNextSupport,initialNextState} from '../lib/flow-next.js'
import {runCheckRequest} from '../lib/flow-check-run.js'

test('observed fingerprints normalize absolute slash and relative workspace roots without granting escapes',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'flow-root-contract-'))
  const root=path.join(parent,'workspace')
  try{
    await fs.mkdir(root);await fs.writeFile(path.join(root,'source.js'),'export const value = 1\n')
    await fs.writeFile(path.join(parent,'outside.js'),'outside')
    const digest=createHash('sha256').update('export const value = 1\n').digest('hex')
    for(const raw of [root,root.replaceAll('\\','/'),path.relative(process.cwd(),root)]){
      assert.equal((await fingerprintObserved(raw,['source.js']))['source.js'],digest,raw)
      const ledger=new FlowEvidence({root:raw});assert.equal((await ledger.snapshot(['source.js']))['source.js'],digest)
      assert.equal((await fingerprintObserved(raw,['../outside.js']))['../outside.js'],null)
      assert.equal((await fingerprintObserved(raw,['source.js'],{files:1,bytes:1}))['source.js'],null)
    }
    const link=path.join(root,'external');await fs.symlink(parent,link,process.platform==='win32'?'junction':'dir')
    assert.equal((await fingerprintObserved(root,['external/outside.js']))['external/outside.js'],null)
  }finally{await fs.rm(parent,{recursive:true,force:true})}
})
test('read-only observation truncation is not described as a partial check scope',()=>{
  const state={...initialNextState(),toolCalls:25}
  assert.doesNotMatch(renderNextSupport(state,{last:[],unresolved:[],unobserved:true}),/Check scope is partial/)
  assert.match(renderNextSupport(state,{last:[{state:'exited-zero',freshness:'observed-inputs-unchanged',omittedInputs:['dependency.js']}],unresolved:[],unobserved:true}),/Check scope is partial/)
})
test('check wrapper admits valid native timeouts and rejects invalid numbers',()=>{
  const args={label:'native limits',command:'node --check source.js',files:['source.js']}
  for(const timeoutMs of [1,300000,600000,900000])assert.equal(runCheckRequest.safeParse({...args,timeoutMs}).success,true)
  for(const timeoutMs of [0,-1,1.5,Infinity,NaN])assert.equal(runCheckRequest.safeParse({...args,timeoutMs}).success,false)
})
